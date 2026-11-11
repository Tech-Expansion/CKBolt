import { loadHubConfig } from "../../../src/config/hub.config";
import { readEnvExample } from "../../support/env-example";
import { INBOUND_CKB_AMOUNT, INBOUND_ENV, INBOUND_RUSD_AMOUNT, P2P_ADDR, WS_ADDR, WSS_ADDR } from "./fiber-access.fixtures";

/**
 * HubConfig.fiberPeers from the environment (plan, "Contract for the browser Fiber node"): FIBER_PUBLIC_WS_ADDRS and
 * FIBER_PUBLIC_P2P_ADDRS (comma-separated multiaddrs, may be empty), FIBER_INBOUND_ENABLED (default false), the
 * inbound amounts in base units and the three caps. Everything validated at start-up, with the variable named.
 */

const NEW_VARIABLES = [
  "FIBER_PUBLIC_P2P_ADDRS",
  "FIBER_PUBLIC_WS_ADDRS",
  "FIBER_INBOUND_ENABLED",
  "FIBER_INBOUND_CKB_AMOUNT",
  "FIBER_INBOUND_RUSD_AMOUNT",
  "FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY",
  "FIBER_INBOUND_MAX_PER_NODE_PER_DAY",
  "FIBER_INBOUND_MAX_OPEN",
  "FIBER_PEER_CHANNELS_MAX_OPEN",
] as const;

/** loadHubConfig's error for `env`, or a failure when it loads. */
function configError(env: Record<string, string>): string {
  try {
    loadHubConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`expected the config to be refused: ${JSON.stringify(env)}`);
}

describe("HubConfig.fiberPeers (env -> config)", () => {
  describe("defaults", () => {
    it("offers no address and no inbound channel unless configured, with the documented caps", () => {
      expect(loadHubConfig({}).fiberPeers).toEqual({
        publicAddresses: { p2p: [], ws: [] },
        inboundChannels: {
          enabled: false,
          amounts: {},
          autoAcceptAmounts: {},
          maxPerClientPerDay: 2,
          maxPerNodePerDay: 2,
          maxPerDay: 10,
          maxOpen: 20,
          acceptTimeoutSeconds: 600,
        },
        peerChannels: { terms: {}, maxOpen: 10 },
      });
    });

    it("keeps inbound channels off when only the amounts are set", () => {
      const config = loadHubConfig({ FIBER_INBOUND_CKB_AMOUNT: "100", FIBER_PUBLIC_WS_ADDRS: WS_ADDR });
      expect(config.fiberPeers.inboundChannels.enabled).toBe(false);
    });
  });

  describe("public addresses", () => {
    it("reads comma-separated multiaddrs, trimming spaces and dropping empty entries, in order", () => {
      const config = loadHubConfig({ FIBER_PUBLIC_WS_ADDRS: ` ${WS_ADDR} ,, ${WSS_ADDR} ,`, FIBER_PUBLIC_P2P_ADDRS: `${P2P_ADDR},` });
      expect(config.fiberPeers.publicAddresses).toEqual({ p2p: [P2P_ADDR], ws: [WS_ADDR, WSS_ADDR] });
    });

    it("may be empty", () => {
      expect(loadHubConfig({ FIBER_PUBLIC_WS_ADDRS: "", FIBER_PUBLIC_P2P_ADDRS: " " }).fiberPeers.publicAddresses).toEqual({ p2p: [], ws: [] });
    });

    it("keeps a /p2p/<peer id> suffix as it is (taken from the config, never rewritten)", () => {
      const ws = `${WS_ADDR}/p2p/QmeBMP2oD7yGmFysdMKAuJRymBDtheZJERdF7xuXH2yuQf`;
      expect(loadHubConfig({ FIBER_PUBLIC_WS_ADDRS: ws }).fiberPeers.publicAddresses.ws).toEqual([ws]);
    });

    it.each([
      ["a plain TCP multiaddr", P2P_ADDR],
      ["a ws:// URL", "ws://203.0.113.7:8228"],
      ["a host and port", "203.0.113.7:8228"],
      ["a path with an empty segment", "/ip4//tcp/8228/ws"],
    ])("refuses %s as a WebSocket address, naming the variable", (_what, address) => {
      expect(configError({ FIBER_PUBLIC_WS_ADDRS: `${WS_ADDR},${address}` })).toMatch(/FIBER_PUBLIC_WS_ADDRS/);
    });

    it.each([
      ["a host and port", "203.0.113.7:8228"],
      ["a URL", "tcp://203.0.113.7:8228"],
      ["a lone separator", "/"],
      ["a path with an empty segment", "/ip4//tcp/8228"],
    ])("refuses %s as a P2P address, naming the variable", (_what, address) => {
      expect(configError({ FIBER_PUBLIC_P2P_ADDRS: address })).toMatch(/FIBER_PUBLIC_P2P_ADDRS/);
    });
  });

  describe("inbound channels", () => {
    it("reads the amounts as exact base units and the caps as given", () => {
      const huge = 2n ** 100n + 7n;
      const config = loadHubConfig({
        ...INBOUND_ENV,
        FIBER_INBOUND_CKB_AMOUNT: huge.toString(),
        FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY: "3",
        FIBER_INBOUND_MAX_PER_NODE_PER_DAY: "4",
        FIBER_INBOUND_MAX_OPEN: "5",
        FIBER_INBOUND_MAX_PER_DAY: "6",
        FIBER_INBOUND_ACCEPT_TIMEOUT_SECONDS: "900",
      });
      expect(config.fiberPeers.inboundChannels).toEqual({
        enabled: true,
        amounts: { CKB: huge, RUSD: INBOUND_RUSD_AMOUNT },
        // A UDT's auto-accept amount is its inbound amount unless FIBER_ASSETS sets one; CKB has none.
        autoAcceptAmounts: { RUSD: INBOUND_RUSD_AMOUNT },
        maxPerClientPerDay: 3,
        maxPerNodePerDay: 4,
        maxPerDay: 6,
        maxOpen: 5,
        acceptTimeoutSeconds: 900,
      });
    });

    it("leaves an asset without an amount out of the amounts", () => {
      const { FIBER_INBOUND_RUSD_AMOUNT: _left, ...ckbOnly } = INBOUND_ENV;
      expect(loadHubConfig(ckbOnly).fiberPeers.inboundChannels.amounts).toEqual({ CKB: INBOUND_CKB_AMOUNT });
    });

    it.each(["true", "1", "yes"])("turns inbound channels on with %s", (value) => {
      expect(loadHubConfig({ ...INBOUND_ENV, FIBER_INBOUND_ENABLED: value }).fiberPeers.inboundChannels.enabled).toBe(true);
    });

    it.each(["false", "0", "no"])("turns inbound channels off with %s", (value) => {
      expect(loadHubConfig({ ...INBOUND_ENV, FIBER_INBOUND_ENABLED: value }).fiberPeers.inboundChannels.enabled).toBe(false);
    });

    it("refuses a value it cannot read as a switch", () => {
      expect(configError({ ...INBOUND_ENV, FIBER_INBOUND_ENABLED: "on" })).toMatch(/FIBER_INBOUND_ENABLED/);
    });

    it.each(["0", "-1", "1.5", "abc", "1e9"])("refuses %s as an amount of base units", (amount) => {
      expect(configError({ ...INBOUND_ENV, FIBER_INBOUND_CKB_AMOUNT: amount })).toMatch(/FIBER_INBOUND_CKB_AMOUNT/);
      expect(configError({ ...INBOUND_ENV, FIBER_INBOUND_RUSD_AMOUNT: amount })).toMatch(/FIBER_INBOUND_RUSD_AMOUNT/);
    });

    it.each(["FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY", "FIBER_INBOUND_MAX_PER_NODE_PER_DAY", "FIBER_INBOUND_MAX_PER_DAY", "FIBER_INBOUND_MAX_OPEN"])(
      "refuses a cap %s that is not a positive whole number",
      (name) => {
        for (const value of ["0", "-1", "1.5", "many"]) expect(configError({ ...INBOUND_ENV, [name]: value })).toMatch(new RegExp(name));
      },
    );

    it("refuses inbound channels on without any amount: there would be nothing to offer", () => {
      const { FIBER_INBOUND_CKB_AMOUNT: _ckb, FIBER_INBOUND_RUSD_AMOUNT: _rusd, ...noAmount } = INBOUND_ENV;
      expect(configError(noAmount)).toMatch(/FIBER_INBOUND_ENABLED.*FIBER_INBOUND_CKB_AMOUNT|FIBER_INBOUND_CKB_AMOUNT.*FIBER_INBOUND_ENABLED/);
    });

    it("refuses inbound channels on without any public address: no node could connect first", () => {
      expect(configError({ ...INBOUND_ENV, FIBER_PUBLIC_P2P_ADDRS: "", FIBER_PUBLIC_WS_ADDRS: "" })).toMatch(/FIBER_PUBLIC_WS_ADDRS/);
    });

    it("takes inbound channels on with only a P2P address, or only a WebSocket one", () => {
      expect(() => loadHubConfig({ ...INBOUND_ENV, FIBER_PUBLIC_WS_ADDRS: "" })).not.toThrow();
      expect(() => loadHubConfig({ ...INBOUND_ENV, FIBER_PUBLIC_P2P_ADDRS: "" })).not.toThrow();
    });
  });

  describe(".env.example", () => {
    it("documents every new variable", () => {
      const example = readEnvExample();
      for (const name of NEW_VARIABLES) expect(Object.keys(example)).toContain(name);
    });

    it("has defaults that equal the config's own defaults (inbound off, empty addresses, the same caps)", () => {
      const example = readEnvExample();
      const fromExample = loadHubConfig(Object.fromEntries(NEW_VARIABLES.filter((name) => !name.endsWith("_AMOUNT")).map((name) => [name, example[name] ?? ""])));
      expect(fromExample.fiberPeers).toEqual(loadHubConfig({}).fiberPeers);
    });

    it("has example amounts that load and are whole base units", () => {
      const example = readEnvExample();
      const config = loadHubConfig({ ...INBOUND_ENV, FIBER_INBOUND_CKB_AMOUNT: example.FIBER_INBOUND_CKB_AMOUNT ?? "", FIBER_INBOUND_RUSD_AMOUNT: example.FIBER_INBOUND_RUSD_AMOUNT ?? "" });
      expect(config.fiberPeers.inboundChannels.amounts.CKB).toBe(BigInt(example.FIBER_INBOUND_CKB_AMOUNT ?? "0"));
      expect(config.fiberPeers.inboundChannels.amounts.RUSD).toBe(BigInt(example.FIBER_INBOUND_RUSD_AMOUNT ?? "0"));
    });
  });
});
