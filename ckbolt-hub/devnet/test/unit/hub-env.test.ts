import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseEnv } from "node:util";
import { parse as dotenvParse } from "dotenv";
import { loadHubConfig } from "../../../src/config/hub.config";
import type { Script } from "../../../src/domain/types";
import { renderHubEnv, type HubEnvInput } from "../../scripts/lib/hub-env";

const RUSD: Script = {
  codeHash: `0x${"50".repeat(32)}`,
  hashType: "data2",
  args: `0x${"32".repeat(32)}`,
};

const INPUT: HubEnvInput = {
  endpoints: {
    lndHubGrpc: "127.0.0.1:10009",
    lndUserGrpc: "127.0.0.1:10010",
    ckbRpcUrl: "http://127.0.0.1:8114",
    fnnHubRpcUrl: "http://127.0.0.1:8227",
    fnnUserRpcUrl: "http://127.0.0.1:8237",
  },
  hubLnd: { tlsCertPath: "./devnet/.secrets/lnd-hub/tls.cert", macaroonPath: "./devnet/.secrets/lnd-hub/hub.macaroon" },
  demoLnd: { tlsCertPath: "./devnet/.secrets/lnd-user/tls.cert", macaroonPath: "./devnet/.secrets/lnd-user/demo.macaroon" },
  rusdTypeScript: RUSD,
};

const rendered = renderHubEnv(INPUT);
/** The two ways the hub may load a .env file: the dotenv package and Node's own --env-file parser. */
const parsers = { dotenv: dotenvParse, "node --env-file": parseEnv } as const;

describe("renderHubEnv", () => {
  it("ends with a newline and starts with a comment header", () => {
    assert.ok(rendered.endsWith("\n"));
    assert.ok(rendered.startsWith("# "));
  });

  for (const [parserName, parse] of Object.entries(parsers)) {
    describe(`parsed by ${parserName}`, () => {
      const env = parse(rendered) as Record<string, string>;

      it("is accepted by the hub's own config loader", () => {
        assert.doesNotThrow(() => loadHubConfig(env));
      });

      it("points the hub at the hub nodes and the demo wallet at the user nodes", () => {
        const config = loadHubConfig(env);
        assert.equal(config.lnd.grpcHost, INPUT.endpoints.lndHubGrpc);
        assert.equal(config.lnd.macaroonPath, INPUT.hubLnd.macaroonPath);
        assert.equal(config.lnd.tlsCertPath, INPUT.hubLnd.tlsCertPath);
        assert.equal(config.fiber.rpcUrl, INPUT.endpoints.fnnHubRpcUrl);
        assert.equal(config.fiber.authToken, undefined, "devnet fnn needs no Biscuit token");
        assert.equal(config.demo.enabled, true);
        assert.equal(config.demo.lnd?.grpcHost, INPUT.endpoints.lndUserGrpc);
        assert.equal(config.demo.lnd?.macaroonPath, INPUT.demoLnd.macaroonPath);
        assert.equal(config.demo.fiber?.rpcUrl, INPUT.endpoints.fnnUserRpcUrl);
      });

      it("selects regtest and devnet with the regtest timing profile", () => {
        const config = loadHubConfig(env);
        assert.equal(config.bitcoin.network, "regtest");
        assert.equal(config.ckb.network, "devnet");
        assert.equal(config.timing.name, "regtest");
      });

      it("carries UDT_RUSD_SCRIPT as the exact RUSD stand-in type script", () => {
        assert.deepEqual(loadHubConfig(env).ckb.udtAssets.find((asset) => asset.id === "RUSD")?.udtTypeScript, RUSD);
      });

      it("uses the least-privilege macaroons, never admin.macaroon", () => {
        assert.ok(!rendered.includes("admin.macaroon"));
      });
    });
  }

  it("never points the hub and the demo wallet at the same node", () => {
    const env = dotenvParse(rendered);
    assert.notEqual(env.LND_GRPC_HOST, env.DEMO_LND_GRPC_HOST);
    assert.notEqual(env.FIBER_RPC_URL, env.DEMO_FIBER_RPC_URL);
  });

  it("only writes variables the hub knows (no typos the hub would silently ignore)", () => {
    const known = documentedHubVariables();
    for (const name of Object.keys(dotenvParse(rendered))) assert.ok(known.has(name), `${name} is not a hub variable`);
  });
});

/** Every variable .env.example documents (commented or not): the hub's public list of settings. */
function documentedHubVariables(): Set<string> {
  const example = readFileSync(join(__dirname, "..", "..", "..", ".env.example"), "utf8");
  return new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1] as string));
}
