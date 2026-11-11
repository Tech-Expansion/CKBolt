import { LND_DEFAULT_HOLD_EXPIRY_DELTA_BLOCKS, MS_PER_SECOND } from "../../../src/common/constants/protocol.constants";
import { TIMING_PROFILES, type TimingProfileName } from "../../../src/common/constants/timing.constants";
import { loadHubConfig, type HubConfig } from "../../../src/config/hub.config";
import { readEnvExample } from "../../support/env-example";

/**
 * HubConfig tunables of the security review's second wave: defaults documented in .env.example, validation, and the
 * start-up checks that tie them to other settings.
 */

interface CountTunable {
  env: string;
  read: (config: HubConfig) => number;
  /** 0 is a valid value. */
  zeroAllowed: boolean;
}

const COUNT_TUNABLES: readonly CountTunable[] = [
  { env: "PAYOUT_MAX_RESENDS", read: (c) => c.swaps.payoutMaxResends, zeroAllowed: true },
  { env: "SWAP_MAX_UNPAID_PER_CLIENT", read: (c) => c.swaps.maxUnpaidSwapsPerClient, zeroAllowed: false },
  { env: "SWAP_MAX_UNPAID", read: (c) => c.swaps.maxUnpaidSwaps, zeroAllowed: false },
  { env: "HUB_RATE_LIMIT_MAX_CLIENTS", read: (c) => c.server.rateLimitMaxClients, zeroAllowed: false },
  { env: "DEMO_MAX_ACTIONS_PER_HOUR_TOTAL", read: (c) => c.demo.maxTotalActionsPerHour, zeroAllowed: false },
];

describe("HubConfig: security tunables (wave 2)", () => {
  describe.each(COUNT_TUNABLES)("$env", ({ env, read, zeroAllowed }) => {
    it("is documented in .env.example with the default the code uses", () => {
      const documented = readEnvExample()[env];
      expect(documented).toBeDefined();
      expect(read(loadHubConfig({}))).toBe(Number(documented));
    });

    it("is read from its env var", () => {
      expect(read(loadHubConfig({ [env]: "7" }))).toBe(7);
    });

    it.each(["abc", "-1", "1.5"])("refuses %p, naming the variable", (value) => {
      expect(() => loadHubConfig({ [env]: value })).toThrow(env);
    });

    it(zeroAllowed ? "accepts 0" : "refuses 0", () => {
      if (zeroAllowed) expect(read(loadHubConfig({ [env]: "0" }))).toBe(0);
      else expect(() => loadHubConfig({ [env]: "0" })).toThrow(env);
    });
  });

  describe("LND_HOLD_EXPIRY_DELTA_BLOCKS (must equal the hub LND's invoices.holdexpirydelta)", () => {
    it("is documented in .env.example as LND's default, 18", () => {
      expect(readEnvExample().LND_HOLD_EXPIRY_DELTA_BLOCKS).toBe(String(LND_DEFAULT_HOLD_EXPIRY_DELTA_BLOCKS));
      expect(LND_DEFAULT_HOLD_EXPIRY_DELTA_BLOCKS).toBe(18);
    });

    it.each(Object.keys(TIMING_PROFILES) as TimingProfileName[])("defaults to 18 on the %s profile and overrides it when set", (profile) => {
      expect(loadHubConfig({ TIMING_PROFILE: profile }).timing.lndHoldExpiryDeltaBlocks).toBe(18);
      expect(loadHubConfig({ TIMING_PROFILE: profile, LND_HOLD_EXPIRY_DELTA_BLOCKS: "40" }).timing.lndHoldExpiryDeltaBlocks).toBe(40);
    });

    it.each(["17", "16", "0", "-18", "18.5", "abc"])("refuses %p: the hub runs with 18 blocks or more", (value) => {
      expect(() => loadHubConfig({ LND_HOLD_EXPIRY_DELTA_BLOCKS: value })).toThrow("LND_HOLD_EXPIRY_DELTA_BLOCKS");
    });

    it("accepts exactly 18", () => {
      expect(loadHubConfig({ LND_HOLD_EXPIRY_DELTA_BLOCKS: "18" }).timing.lndHoldExpiryDeltaBlocks).toBe(18);
    });
  });

  describe("PAYOUT_MISSING_CONFIRM_SECONDS (wait before refunding a payout the node has no record of)", () => {
    it("is documented in .env.example with the default the code uses", () => {
      expect(loadHubConfig({}).swaps.payoutMissingConfirmMs).toBe(Number(readEnvExample().PAYOUT_MISSING_CONFIRM_SECONDS) * MS_PER_SECOND);
    });

    it("is read in seconds", () => {
      expect(loadHubConfig({ PAYOUT_MISSING_CONFIRM_SECONDS: "45" }).swaps.payoutMissingConfirmMs).toBe(45 * MS_PER_SECOND);
    });

    it.each(["0", "-1", "2.5", "abc"])("refuses %p", (value) => {
      expect(() => loadHubConfig({ PAYOUT_MISSING_CONFIRM_SECONDS: value })).toThrow("PAYOUT_MISSING_CONFIRM_SECONDS");
    });

    it("refuses a wait shorter than the Fiber RPC timeout, naming both: a timed-out send may still be starting", () => {
      const env = { PAYOUT_MISSING_CONFIRM_SECONDS: "9", FIBER_RPC_TIMEOUT_MS: "10000" };
      expect(() => loadHubConfig(env)).toThrow(/^Invalid hub configuration: PAYOUT_MISSING_CONFIRM_SECONDS .*FIBER_RPC_TIMEOUT_MS/);
    });

    it("accepts a wait of exactly the Fiber RPC timeout", () => {
      const config = loadHubConfig({ PAYOUT_MISSING_CONFIRM_SECONDS: "10", FIBER_RPC_TIMEOUT_MS: "10000" });
      expect(config.swaps.payoutMissingConfirmMs).toBe(config.fiber.rpcTimeoutMs);
    });
  });

  describe("HUB_TRUST_PROXY needs a HUB_HOST only the proxy can reach", () => {
    it.each(["127.0.0.1", "::1", "localhost", "LOCALHOST", "10.8.0.2", "172.20.0.4", "192.168.1.10", "fd00::5", "0.0.0.0", "::"])(
      "accepts HUB_HOST=%s",
      (host) => {
        expect(loadHubConfig({ HUB_TRUST_PROXY: "true", HUB_HOST: host }).server).toMatchObject({ host, trustProxy: true });
      },
    );

    it.each(["203.0.113.5", "8.8.8.8", "2001:db8::1", "hub.example.com"])("refuses HUB_HOST=%s, naming both variables", (host) => {
      const load = () => loadHubConfig({ HUB_TRUST_PROXY: "true", HUB_HOST: host });
      expect(load).toThrow(/^Invalid hub configuration: HUB_TRUST_PROXY=true needs HUB_HOST/);
      expect(load).toThrow(host);
    });

    it("leaves HUB_HOST free when the proxy is not trusted", () => {
      expect(loadHubConfig({ HUB_TRUST_PROXY: "false", HUB_HOST: "203.0.113.5" }).server.host).toBe("203.0.113.5");
    });
  });
});
