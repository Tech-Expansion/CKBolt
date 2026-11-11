import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIBER_MAX_COMMITMENT_DELAY_EPOCHS, MS_PER_MINUTE } from "../../../src/common/constants/protocol.constants";
import { TIMING_PROFILES, type TimingProfileName } from "../../../src/common/constants/timing.constants";
import { loadEnvFile } from "../../../src/config/env-file";
import { loadHubConfig } from "../../../src/config/hub.config";

/** The tunables that used to be constants, now HubConfig fields with env vars (.env.example), and the env file. */
describe("HubConfig tunables", () => {
  it("has the documented defaults", () => {
    const config = loadHubConfig({});

    expect(config.pricing.priceCacheMs).toBe(15_000);
    expect(config.fiber).toMatchObject({ rpcTimeoutMs: 10_000, pubsubReconnectMs: 5_000 });
    expect(config.health.timeoutMs).toBe(5_000);
    expect(config.demo.payoutInvoiceExtraSeconds).toBe(3_600);
    expect(config.swaps.lnMaxPaymentParts).toBe(16);
    expect(config.timing.lnRouteBudgetBlocks).toBe(TIMING_PROFILES.regtest.lnRouteBudgetBlocks);
  });

  it("reads each one from its env var", () => {
    const config = loadHubConfig({
      PRICE_CACHE_MS: "0",
      FIBER_RPC_TIMEOUT_MS: "2500",
      FIBER_PUBSUB_RECONNECT_MS: "750",
      HEALTH_CHECK_TIMEOUT_MS: "1500",
      DEMO_PAYOUT_INVOICE_EXTRA_SECONDS: "600",
      LN_MAX_PAYMENT_PARTS: "1",
      LN_ROUTE_BUDGET_BLOCKS: "40",
    });

    expect(config.pricing.priceCacheMs).toBe(0);
    expect(config.fiber).toMatchObject({ rpcTimeoutMs: 2_500, pubsubReconnectMs: 750 });
    expect(config.health.timeoutMs).toBe(1_500);
    expect(config.demo.payoutInvoiceExtraSeconds).toBe(600);
    expect(config.swaps.lnMaxPaymentParts).toBe(1);
    expect(config.timing.lnRouteBudgetBlocks).toBe(40);
  });

  it("takes the route budget from the timing profile unless LN_ROUTE_BUDGET_BLOCKS overrides it", () => {
    expect(loadHubConfig({ TIMING_PROFILE: "mutinynet" }).timing.lnRouteBudgetBlocks).toBe(TIMING_PROFILES.mutinynet.lnRouteBudgetBlocks);
    expect(TIMING_PROFILES.mutinynet.lnRouteBudgetBlocks).toBeGreaterThan(TIMING_PROFILES.regtest.lnRouteBudgetBlocks);
  });

  it.each([
    ["LN_MAX_PAYMENT_PARTS", "0"],
    ["FIBER_RPC_TIMEOUT_MS", "-1"],
    ["HEALTH_CHECK_TIMEOUT_MS", "soon"],
    ["PRICE_CACHE_MS", "-5"],
    ["LN_ROUTE_BUDGET_BLOCKS", "1.5"],
  ])("refuses %s=%s, naming the variable", (name, value) => {
    expect(() => loadHubConfig({ [name]: value })).toThrow(name);
  });
});

describe("HubConfig security bounds", () => {
  describe("payout routing fee budgets stay below the hub fee (the payee can collect the whole budget)", () => {
    it("defaults to budgets below FEE_BPS", () => {
      const config = loadHubConfig({});
      expect(config.swaps.lnMaxFeeBps).toBeLessThan(config.pricing.feeBps);
      expect(config.swaps.fiberMaxFeeBps).toBeLessThan(config.pricing.feeBps);
    });

    it.each([
      ["LN_MAX_FEE_BPS", { LN_MAX_FEE_BPS: "50" }],
      ["LN_MAX_FEE_BPS", { LN_MAX_FEE_BPS: "100" }],
      ["FIBER_MAX_FEE_BPS", { FIBER_MAX_FEE_BPS: "50" }],
      ["LN_MAX_FEE_BPS", { FEE_BPS: "20" }],
    ])("refuses a %s that is not below FEE_BPS (%p), naming both", (name, env) => {
      expect(() => loadHubConfig(env)).toThrow(/^Invalid hub configuration: .*FEE_BPS/);
      expect(() => loadHubConfig(env)).toThrow(name);
    });

    it("accepts budgets just below FEE_BPS", () => {
      const config = loadHubConfig({ FEE_BPS: "80", LN_MAX_FEE_BPS: "79", FIBER_MAX_FEE_BPS: "79" });
      expect(config.swaps).toMatchObject({ lnMaxFeeBps: 79, fiberMaxFeeBps: 79 });
    });
  });

  describe("MAX_PAYOUT_LOCK_MINUTES (the longest a payout may lock the hub's funds)", () => {
    it.each(Object.keys(TIMING_PROFILES) as TimingProfileName[])("defaults to the %s profile's cap and overrides it when set", (profile) => {
      expect(loadHubConfig({ TIMING_PROFILE: profile }).timing.maxPayoutLockMs).toBe(TIMING_PROFILES[profile].maxPayoutLockMs);
      expect(loadHubConfig({ TIMING_PROFILE: profile, MAX_PAYOUT_LOCK_MINUTES: "90" }).timing.maxPayoutLockMs).toBe(90 * MS_PER_MINUTE);
    });

    it("every profile caps the payout lock well below the 14 days the payer limits allow", () => {
      for (const profile of Object.values(TIMING_PROFILES)) expect(profile.maxPayoutLockMs).toBeLessThanOrEqual(4 * 24 * 60 * MS_PER_MINUTE);
    });
  });

  describe("FIBER_PEER_CHANNEL_COMMITMENT_DELAY_EPOCHS (delay assumed for channels a peer opened)", () => {
    it("defaults to the longest delay fnn accepts from an opener", () => {
      expect(loadHubConfig({}).swaps.fiberPeerChannelCommitmentDelayEpochs).toBe(FIBER_MAX_COMMITMENT_DELAY_EPOCHS);
    });

    it.each(["0", "85", "2.5"])("refuses %s: fnn accepts whole epochs from 1 to 84", (value) => {
      expect(() => loadHubConfig({ FIBER_PEER_CHANNEL_COMMITMENT_DELAY_EPOCHS: value })).toThrow("FIBER_PEER_CHANNEL_COMMITMENT_DELAY_EPOCHS");
    });
  });
});

describe("loadEnvFile", () => {
  const KEY = "CKBOLT_ENV_FILE_SPEC_VALUE";
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ckbolt-env-"));
    delete process.env[KEY];
  });

  afterEach(() => {
    delete process.env[KEY];
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads KEY=value lines into the environment", () => {
    const file = join(dir, ".env");
    writeFileSync(file, `${KEY}=from-file\n`);
    loadEnvFile(file);
    expect(process.env[KEY]).toBe("from-file");
  });

  it("leaves a variable already set in the environment alone", () => {
    const file = join(dir, ".env");
    writeFileSync(file, `${KEY}=from-file\n`);
    process.env[KEY] = "from-environment";
    loadEnvFile(file);
    expect(process.env[KEY]).toBe("from-environment");
  });

  it("does nothing when the file does not exist", () => {
    expect(() => loadEnvFile(join(dir, "missing.env"))).not.toThrow();
    expect(process.env[KEY]).toBeUndefined();
  });
});
