import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { posix, resolve } from "node:path";
import {
  cancelHodlInvoice,
  createChainAddress,
  createHodlInvoice,
  getChainBalance,
  getChannelBalance,
  getWalletInfo,
  type AuthenticatedLnd,
} from "lightning";
import { LND_MIN_INVOICE_CLTV_EXPIRY, MS_PER_SECOND } from "../../../src/common/constants/protocol.constants";
import type { LndConnection } from "../../../src/config/hub.config";
import { connectLnd, disconnectLnd } from "../../../src/infrastructure/lightning/lnd-connection";
import { isAccessDenied, readLndError } from "../../../src/infrastructure/lightning/lnd.errors";
import { CkbChain } from "../../scripts/lib/ckb";
import { BAKED_MACAROON, HUB_MACAROON_PERMISSIONS, LNCLI, LND_CONTAINER_FILE, SECRET_FILE, SERVICE } from "../../scripts/lib/devnet.constants";
import { JsonRpcClient } from "../../scripts/lib/json-rpc";
import { newPaymentSecret } from "../../scripts/lib/payment-secret";
import { nodeWhitelistsRusd, rusdStandIn } from "../../scripts/lib/rusd";
import { CHECK_INVOICE_DESCRIPTION, CHECK_INVOICE_EXPIRY_SECONDS, LND_SECRET_FILES } from "./check.constants";
import { readHubEnv, readHubFile, requireHubEnv, type LiveContext } from "./live-context";
import type { CheckRunner } from "./runner";

type LndService = keyof typeof LND_SECRET_FILES;

const containerPathOf = (file: string): string =>
  file === SECRET_FILE.TLS_CERT ? LND_CONTAINER_FILE.TLS_CERT : posix.join(LND_CONTAINER_FILE.MACAROON_DIR, file);

async function withLnd<T>(live: LiveContext, connection: LndConnection, use: (lnd: AuthenticatedLnd) => Promise<T>): Promise<T> {
  const lnd = connectLnd(connection, (path) => readHubFile(live, path));
  try {
    return await use(lnd);
  } finally {
    disconnectLnd(lnd);
  }
}

const identityOf = async (live: LiveContext, service: LndService): Promise<string> =>
  (await live.devnet.compose.execJson<{ identity_pubkey: string }>(service, [...LNCLI, "getinfo"])).identity_pubkey;

export async function checkSecretsAndHubEnv(live: LiveContext, runner: CheckRunner): Promise<void> {
  runner.section("Secrets and hub.env: what the hub reads");

  const hubEnvValid = await runner.check("hub.env exists and the hub's own config loader accepts it", async () => {
    live.hubEnv = readHubEnv(live);
    return `${Object.keys(live.hubEnv.vars).length} variables`;
  });
  if (!hubEnvValid) return;
  const { config } = requireHubEnv(live);

  await runner.check("hub.env points the hub at the *-hub nodes and the demo wallet at the *-user nodes, on the published ports", async () => {
    assert.equal(config.lnd.grpcHost, live.endpoints.lndHubGrpc);
    assert.equal(config.fiber.rpcUrl, live.endpoints.fnnHubRpcUrl);
    assert.equal(config.demo.enabled, true);
    assert.equal(config.demo.lnd?.grpcHost, live.endpoints.lndUserGrpc);
    assert.equal(config.demo.fiber?.rpcUrl, live.endpoints.fnnUserRpcUrl);
  });

  await runner.check("every credential file hub.env names exists", async () => {
    const paths = [config.lnd.tlsCertPath, config.lnd.macaroonPath, config.demo.lnd?.tlsCertPath, config.demo.lnd?.macaroonPath];
    for (const path of paths) {
      assert.ok(path, "a credential path is not set");
      assert.ok(existsSync(resolve(live.hubRoot, path)), `${path} does not exist`);
    }
  });

  for (const [service, files] of Object.entries(LND_SECRET_FILES) as [LndService, readonly string[]][]) {
    await runner.check(`devnet/.secrets/${service} holds the node's current TLS cert and macaroons`, async () => {
      for (const file of files) {
        const inContainer = (await live.devnet.compose.exec(service, ["base64", "-w0", containerPathOf(file)])).trim();
        const onHost = readHubFile(live, posix.join("devnet", ".secrets", service, file)).toString("base64");
        assert.equal(onHost, inContainer, `${file} differs from the container's copy`);
      }
      return files.join(", ");
    });
  }

  for (const [service, macaroon] of [[SERVICE.LND_HUB, BAKED_MACAROON.HUB], [SERVICE.LND_USER, BAKED_MACAROON.DEMO]] as const) {
    await runner.check(`${service}'s ${macaroon} has exactly the least-privilege permissions`, async () => {
      const printed = await live.devnet.compose.execJson<{ permissions: string[] }>(service, [...LNCLI, "printmacaroon", `--macaroon_file=${containerPathOf(macaroon)}`]);
      assert.deepEqual([...printed.permissions].sort(), [...HUB_MACAROON_PERMISSIONS].sort());
      return printed.permissions.join(" ");
    });
  }

  await runner.check("the hub reaches lnd-hub over gRPC from the host with hub.env's TLS cert and macaroon", async () => {
    const info = await withLnd(live, config.lnd, (lnd) => getWalletInfo({ lnd }));
    assert.equal(info.public_key, await identityOf(live, SERVICE.LND_HUB));
    assert.equal(info.is_synced_to_chain, true, "lnd-hub is not synced to the chain");
  });

  await runner.check("the hub macaroon reads the on-chain balance but cannot touch the on-chain wallet (least privilege)", async () => {
    await withLnd(live, config.lnd, async (lnd) => {
      await getChainBalance({ lnd });
      await assert.rejects(createChainAddress({ lnd }), (error: unknown) => isAccessDenied(readLndError(error)));
    });
  });

  await runner.check("the hub macaroon can read channel balances and create and cancel a hold invoice", async () => {
    await withLnd(live, config.lnd, async (lnd) => {
      await getChannelBalance({ lnd });
      const { paymentHash } = newPaymentSecret();
      const expiresAt = new Date(live.devnet.clock.now() + CHECK_INVOICE_EXPIRY_SECONDS * MS_PER_SECOND).toISOString();
      await createHodlInvoice({ lnd, id: paymentHash, tokens: 1, cltv_delta: LND_MIN_INVOICE_CLTV_EXPIRY, expires_at: expiresAt, description: CHECK_INVOICE_DESCRIPTION });
      await cancelHodlInvoice({ lnd, id: paymentHash });
    });
  });

  await runner.check("the demo wallet reaches lnd-user over gRPC with its own credentials", async () => {
    assert.ok(config.demo.lnd, "DEMO_LND_* is not set");
    const info = await withLnd(live, config.demo.lnd, (lnd) => getWalletInfo({ lnd }));
    assert.equal(info.public_key, await identityOf(live, SERVICE.LND_USER));
  });

  await runner.check("both fnn RPCs in hub.env answer from the host without a Biscuit token", async () => {
    assert.ok(config.demo.fiber, "DEMO_FIBER_RPC_URL is not set");
    assert.equal(config.fiber.authToken, undefined);
    const pubkeyAt = async (url: string) => (await new JsonRpcClient(url, live.devnet.settings.waits.rpcTimeoutMs).call<{ pubkey: string }>("node_info")).pubkey;
    assert.equal(await pubkeyAt(config.fiber.rpcUrl), (await live.fiber.hub.nodeInfo()).pubkey);
    assert.equal(await pubkeyAt(config.demo.fiber.rpcUrl), (await live.fiber.user.nodeInfo()).pubkey);
  });

  await runner.check("UDT_RUSD_SCRIPT is the chain's RUSD stand-in, and both fnn nodes whitelist it", async () => {
    const ckb = await CkbChain.connect(live.endpoints.ckbRpcUrl);
    const rusd = await rusdStandIn(ckb, live.devnet.settings.ckb.issuerPrivateKey).finally(() => ckb.close());
    assert.deepEqual(config.ckb.udtAssets.find((asset) => asset.id === "RUSD")?.udtTypeScript, rusd.typeScript);
    for (const node of [live.fiber.hub, live.fiber.user]) assert.ok(nodeWhitelistsRusd(await node.nodeInfo(), rusd.typeScript), `${node.name} does not whitelist it`);
    return rusd.typeScript.args;
  });
}
