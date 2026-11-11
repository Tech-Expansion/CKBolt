import { TESTNET_RUSD_TYPE_SCRIPT } from "../../../src/common/constants/assets.constants";
import { describeError } from "../../../src/common/utils/error.util";
import { activeServices, serviceStates, type DeployContext } from "../lib/context";
import { RUNNING_STATE, type ComposeServiceState } from "../lib/compose-state";
import { KIT_FILE, MUTINYNET_LSP, SERVICE, type FnnService, type ServiceName } from "../lib/constants";
import { isSuccess } from "../lib/http";
import { hubMacaroonPath } from "../lib/kit-paths";
import {
  evaluateAnnouncedAddresses,
  evaluateAssets,
  evaluateBitcoind,
  evaluateContainers,
  evaluateFiberChannel,
  evaluateFiberNodeView,
  evaluateFnnNode,
  evaluateFnnPeers,
  evaluateFnnWallet,
  evaluateHubBinding,
  evaluateHubHealth,
  evaluateHubSecrets,
  evaluateLnChannel,
  evaluateLndState,
  evaluateLndSync,
  evaluateLnPeer,
  evaluateOnchain,
  fail,
  ok,
  warn,
  type CheckResult,
} from "./checks";

/** What the server needs besides Docker, and the Ubuntu package of each: curl for the hub checks, ss for `up`'s port guard. */
const SERVER_TOOLS: Readonly<Record<string, string>> = { curl: "curl", ss: "iproute2" };

/**
 * The read-only readiness report: it only asks (no address, invoice, channel or claim is made). One failing part does
 * not stop the others; a probe that throws becomes a failing line with the error.
 */
export async function runCheck(ctx: DeployContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const probe = async (area: string, next: string, read: () => Promise<CheckResult[] | CheckResult>): Promise<void> => {
    try {
      results.push(...[await read()].flat());
    } catch (error) {
      results.push(fail(area, `could not read: ${describeError(error)}`, next));
    }
  };

  const reachable = await checkServer(ctx, results);
  if (!reachable) return results;
  const active = await activeServices(ctx);
  const states = await serviceStates(ctx);
  results.push(...evaluateContainers(active, states));
  const up = (service: ServiceName): boolean => states.get(service)?.state === RUNNING_STATE;

  if (up(SERVICE.BITCOIND)) {
    await probe(SERVICE.BITCOIND, `testnet logs ${SERVICE.BITCOIND}`, async () => evaluateBitcoind(await ctx.bitcoind.blockchainInfo()));
  }
  if (up(SERVICE.LND_HUB)) await probe(SERVICE.LND_HUB, `testnet logs ${SERVICE.LND_HUB}`, () => checkLndHub(ctx));
  if (active.has(SERVICE.LND_DEMO) && up(SERVICE.LND_DEMO)) await probe(SERVICE.LND_DEMO, `testnet logs ${SERVICE.LND_DEMO}`, () => checkLndDemo(ctx));
  if (up(SERVICE.FNN_HUB)) await probe(SERVICE.FNN_HUB, `testnet logs ${SERVICE.FNN_HUB}`, () => checkFnnHub(ctx));
  if (active.has(SERVICE.FNN_DEMO) && up(SERVICE.FNN_DEMO)) await probe(SERVICE.FNN_DEMO, `testnet logs ${SERVICE.FNN_DEMO}`, () => checkFnnDemo(ctx));
  if (up(SERVICE.HUB)) await probe(SERVICE.HUB, `testnet logs ${SERVICE.HUB}`, () => checkHub(ctx, states.get(SERVICE.HUB)));
  await probe("faucets", "check this machine's internet connection", () => checkFaucets(ctx));
  return results;
}

/** SSH, Docker Compose, the server's tools and the kit files; false when nothing else can be checked. */
async function checkServer(ctx: DeployContext, results: CheckResult[]): Promise<boolean> {
  const host = ctx.shell.target.host;
  const compose = await ctx.shell.tryExec("docker compose version --short");
  if (compose.exitCode !== 0) {
    const next = "check DEPLOY_SSH_HOST; `ssh <host>` must log in without a password prompt, and Docker Compose must be installed";
    results.push(fail("server", `${host}: ${(compose.stderr || compose.stdout).trim() || "no answer"}`, next));
    return false;
  }
  results.push(ok("server", `${host}: Docker Compose ${compose.stdout.trim()}`));
  for (const [tool, aptPackage] of Object.entries(SERVER_TOOLS)) {
    const found = (await ctx.shell.tryExec(`command -v ${tool}`)).exitCode === 0;
    results.push(found ? ok("server", `${tool} installed`) : warn("server", `${tool} missing`, `install it on the server (apt-get install ${aptPackage})`));
  }
  for (const file of [KIT_FILE.COMPOSE, KIT_FILE.ENV, KIT_FILE.HUB_ENV]) {
    if (!(await ctx.kit.fileExists(file))) {
      results.push(fail("server", `${ctx.settings.remoteDir}/${file} missing`, "testnet sync, then testnet env"));
      return false;
    }
  }
  results.push(ok("server", `kit in ${ctx.settings.remoteDir}`));
  return true;
}

async function checkLndHub(ctx: DeployContext): Promise<CheckResult[]> {
  const service = SERVICE.LND_HUB;
  const node = ctx.lnd[service];
  const stateResult = evaluateLndState(service, await node.state());
  if (stateResult.status === "fail") return [stateResult];
  const lsp = ctx.settings.peers.lnLspNode.pubkey;
  const minimum = ctx.settings.check.minLiquiditySats;
  const [info, balance, channels, pending, peers, secrets] = await Promise.all([
    node.info(),
    node.walletBalance(),
    node.channels(),
    node.pendingOpenChannels(),
    node.peerPubkeys(),
    ctx.kit.fileExists(hubMacaroonPath(service)),
  ]);
  return [
    stateResult,
    evaluateLndSync(service, info),
    evaluateOnchain(service, balance),
    evaluateLnPeer(service, peers, lsp, MUTINYNET_LSP.LABEL),
    evaluateLnChannel(
      {
        service,
        label: `channel to ${MUTINYNET_LSP.LABEL}`,
        peer: lsp,
        minLocal: minimum,
        minRemote: minimum,
        nextWhenMissing: "fund lnd-hub (testnet fund, hand step 1), then testnet channels",
        nextWhenLowLocal: "open a larger channel (DEPLOY_LN_LSP_CHANNEL_SATS) or let BTC to CKB swaps move sats back to lnd-hub",
        nextWhenLowRemote: "testnet balance",
      },
      channels,
      pending,
    ),
    evaluateHubSecrets(service, secrets),
  ];
}

async function checkLndDemo(ctx: DeployContext): Promise<CheckResult[]> {
  const service = SERVICE.LND_DEMO;
  const node = ctx.lnd[service];
  const stateResult = evaluateLndState(service, await node.state());
  if (stateResult.status === "fail") return [stateResult];
  const [hubInfo, info, balance, channels, pending] = await Promise.all([
    ctx.lnd[SERVICE.LND_HUB].info(),
    node.info(),
    node.walletBalance(),
    node.channels(),
    node.pendingOpenChannels(),
  ]);
  return [
    stateResult,
    evaluateLndSync(service, info),
    evaluateOnchain(service, balance),
    evaluateLnChannel(
      {
        service,
        label: "channel to lnd-hub",
        peer: hubInfo.identity_pubkey,
        minLocal: ctx.settings.check.minLiquiditySats,
        minRemote: 0n,
        nextWhenMissing: "testnet fund (lnd-hub sends lnd-demo its sats), then testnet channels",
        nextWhenLowLocal: "lnd-demo pays the hub's hold invoices from this channel: open a larger one (DEPLOY_LN_DEMO_CHANNEL_SATS)",
        nextWhenLowRemote: "",
      },
      channels,
      pending,
    ),
  ];
}

async function checkFnnHub(ctx: DeployContext): Promise<CheckResult[]> {
  const service = SERVICE.FNN_HUB;
  const node = ctx.fiber[service];
  const { fiberRelays } = ctx.settings.peers;
  const [info, peers] = await Promise.all([node.nodeInfo(), node.peers()]);
  const results = [evaluateFnnNode(service, info), evaluateAnnouncedAddresses(service, info), ...evaluateFnnPeers(service, peers, fiberRelays)];
  results.push(evaluateFnnWallet(service, await ctx.ckbRpc.capacityOf(info.default_funding_lock_script), ctx.settings.ckbFaucet.minHubShannons));
  for (const relay of fiberRelays) {
    results.push(
      evaluateFiberChannel(
        { service, label: `CKB channel to ${relay.address}`, asset: "CKB", udtTypeScript: null, nextWhenMissing: "testnet fund, then testnet channels" },
        await node.channels(relay.pubkey),
      ),
    );
  }
  const [firstRelay] = fiberRelays;
  if (firstRelay && ctx.settings.fiber.relayChannelRusd > 0n) {
    results.push(
      evaluateFiberChannel(
        {
          service,
          label: `RUSD channel to ${firstRelay.address}`,
          asset: "RUSD",
          udtTypeScript: TESTNET_RUSD_TYPE_SCRIPT,
          nextWhenMissing: "send RUSD to fnn-hub (hand step 2), then testnet channels",
        },
        await node.channels(firstRelay.pubkey),
      ),
    );
  }
  return results;
}

async function checkFnnDemo(ctx: DeployContext): Promise<CheckResult[]> {
  const service: FnnService = SERVICE.FNN_DEMO;
  const node = ctx.fiber[service];
  const [info, hubInfo] = await Promise.all([node.nodeInfo(), ctx.fiber[SERVICE.FNN_HUB].nodeInfo()]);
  const channels = await node.channels(hubInfo.pubkey);
  const results = [
    evaluateFnnNode(service, info),
    evaluateFnnWallet(service, await ctx.ckbRpc.capacityOf(info.default_funding_lock_script), ctx.settings.ckbFaucet.minDemoShannons),
    evaluateFiberChannel(
      { service, label: "CKB channel with fnn-hub", asset: "CKB", udtTypeScript: null, nextWhenMissing: "testnet channels" },
      channels,
    ),
  ];
  if (ctx.settings.fiber.demoChannelRusd > 0n) {
    results.push(
      evaluateFiberChannel(
        { service, label: "RUSD channel with fnn-hub", asset: "RUSD", udtTypeScript: TESTNET_RUSD_TYPE_SCRIPT, nextWhenMissing: "testnet channels" },
        channels,
      ),
    );
  }
  return results;
}

async function checkHub(ctx: DeployContext, state: ComposeServiceState | undefined): Promise<CheckResult[]> {
  const hub = await ctx.hubApi();
  const { status, health } = await hub.health();
  const results = [evaluateHubBinding(state?.publishers ?? []), evaluateHubHealth(status, health)];
  results.push(...evaluateAssets(await hub.assets(), ctx.settings.check.minLiquiditySats));
  results.push(evaluateFiberNodeView(await hub.fiberNode()));
  return results;
}

async function checkFaucets(ctx: DeployContext): Promise<CheckResult[]> {
  const mutinynet = await ctx.mutinynetFaucet.home();
  return [
    isSuccess(mutinynet.status)
      ? ok("faucets", `Mutinynet faucet ${ctx.settings.urls.mutinynetFaucet} answers`)
      : warn("faucets", `Mutinynet faucet answered HTTP ${mutinynet.status}`, "try again later; funding and testnet balance need it"),
  ];
}
