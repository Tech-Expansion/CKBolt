import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { loadHubConfig } from "../../../src/config/hub.config";
import { readEnvExample } from "../../support/env-example";
import { CWBTC_ENTRY, ONE_WHOLE, RUSD_ENTRY } from "./assets.fixtures";

/**
 * FIBER_ASSETS `peerChannels`: a UDT in which nodes may open their own channel to the hub's fnn (fnn-hub auto-accepts one
 * funded with at least `minAmount`). fnn does not report the commitment delay such an opener chose (1 to 84 epochs), so
 * the hub refuses to start with FIBER_PEER_CHANNEL_COMMITMENT_DELAY_EPOCHS below 84 while any asset takes them.
 */

const TESTNET = { CKB_NETWORK: "testnet" };
/** 5 cWBTC: the least funding fnn-hub accepts on its own in these examples. */
const MIN_PEER_CWBTC = 5n * ONE_WHOLE;
const CWBTC_WITH_PEERS = { ...CWBTC_ENTRY, peerChannels: { minAmount: MIN_PEER_CWBTC.toString() } };

const withAssets = (entries: unknown[], env: Record<string, string> = {}) =>
  loadHubConfig({ ...TESTNET, FIBER_ASSETS: JSON.stringify(entries), ...env });
const delayEpochs = (epochs: number) => ({ FIBER_PEER_CHANNEL_COMMITMENT_DELAY_EPOCHS: String(epochs) });

describe("FIBER_ASSETS peerChannels", () => {
  describe("parsing", () => {
    it("reads minAmount as a decimal string into fiberPeers.peerChannels.terms, keyed by asset id", () => {
      const config = withAssets([RUSD_ENTRY, CWBTC_WITH_PEERS]);

      expect(config.fiberPeers.peerChannels.terms).toEqual({ CWBTC: { minAmount: 500_000_000n } });
    });

    it("reads minAmount as a JSON number too", () => {
      const config = withAssets([{ ...CWBTC_ENTRY, peerChannels: { minAmount: 500_000_000 } }]);

      expect(config.fiberPeers.peerChannels.terms).toEqual({ CWBTC: { minAmount: 500_000_000n } });
    });

    it("reads a minAmount past the safe integer range written as a string, exactly", () => {
      const config = withAssets([{ ...CWBTC_ENTRY, peerChannels: { minAmount: "123456789012345678901234567890" } }]);

      expect(config.fiberPeers.peerChannels.terms.CWBTC?.minAmount).toBe(123456789012345678901234567890n);
    });

    it("keeps each asset's own terms when several take peer channels", () => {
      const config = withAssets([{ ...RUSD_ENTRY, peerChannels: { minAmount: "1" } }, CWBTC_WITH_PEERS]);

      expect(config.fiberPeers.peerChannels.terms).toEqual({ RUSD: { minAmount: 1n }, CWBTC: { minAmount: MIN_PEER_CWBTC } });
    });

    it("has no terms when no entry sets peerChannels (the VPS example as it was)", () => {
      expect(withAssets([RUSD_ENTRY, CWBTC_ENTRY]).fiberPeers.peerChannels.terms).toEqual({});
    });

    it("has no terms without FIBER_ASSETS (the legacy variables cannot set peerChannels)", () => {
      expect(loadHubConfig(TESTNET).fiberPeers.peerChannels.terms).toEqual({});
    });

    it("does not need inbound channels: an asset may take peer channels and offer none of its own", () => {
      const entry = { ...CWBTC_WITH_PEERS, inboundAmount: undefined, autoAcceptAmount: undefined };

      expect(withAssets([entry]).fiberPeers.peerChannels.terms).toEqual({ CWBTC: { minAmount: MIN_PEER_CWBTC } });
      expect(withAssets([entry]).fiberPeers.inboundChannels.amounts).toEqual({});
    });
  });

  describe("refuses, naming FIBER_ASSETS", () => {
    it.each([
      ["an unknown key next to minAmount (strict)", { minAmount: "1", maxAmount: "2" }],
      ["a misspelt minAmount", { minamount: "1" }],
      ["no minAmount", {}],
      ["minAmount 0 as a string", { minAmount: "0" }],
      ["minAmount 0 as a number", { minAmount: 0 }],
      ["a negative minAmount", { minAmount: "-1" }],
      ["a negative minAmount as a number", { minAmount: -1 }],
      ["a fractional minAmount", { minAmount: "1.5" }],
      ["a fractional minAmount as a number", { minAmount: 1.5 }],
      ["a minAmount past the safe integer range as a JSON number", { minAmount: 2 ** 60 }],
      ["minAmount in hex", { minAmount: "0x10" }],
      ["peerChannels as true", true],
      ["peerChannels as a bare amount", "100"],
      ["peerChannels as null", null],
    ])("%s", (_label, peerChannels) => {
      expect(() => withAssets([{ ...CWBTC_ENTRY, peerChannels }])).toThrow(/^Invalid hub configuration: FIBER_ASSETS/);
    });
  });

  describe("the commitment delay the hub assumes for a channel a node opened", () => {
    it("defaults to 84 epochs (the longest fnn accepts), so peer channels start with nothing else set", () => {
      expect(withAssets([CWBTC_WITH_PEERS]).swaps.fiberPeerChannelCommitmentDelayEpochs).toBe(84);
    });

    it("takes an explicit 84 with peer channels", () => {
      expect(withAssets([CWBTC_WITH_PEERS], delayEpochs(84)).swaps.fiberPeerChannelCommitmentDelayEpochs).toBe(84);
    });

    it.each([83, 42, 1])("refuses to start with %i epochs while an asset takes peer channels, naming the asset", (epochs) => {
      expect(() => withAssets([RUSD_ENTRY, CWBTC_WITH_PEERS], delayEpochs(epochs))).toThrow(
        new RegExp(
          `^Invalid hub configuration: FIBER_PEER_CHANNEL_COMMITMENT_DELAY_EPOCHS \\(${epochs}\\) must stay 84 while FIBER_ASSETS lets nodes open ` +
            "channels to the hub \\(peerChannels in CWBTC\\)",
        ),
      );
    });

    it("names every asset that takes peer channels, in FIBER_ASSETS order", () => {
      const both = [{ ...RUSD_ENTRY, peerChannels: { minAmount: "1" } }, CWBTC_WITH_PEERS];

      expect(() => withAssets(both, delayEpochs(83))).toThrow(/\(peerChannels in RUSD, CWBTC\)/);
    });

    it.each([83, 1])("still takes %i epochs when no asset takes peer channels (the operator's own assumption)", (epochs) => {
      expect(withAssets([RUSD_ENTRY, CWBTC_ENTRY], delayEpochs(epochs)).swaps.fiberPeerChannelCommitmentDelayEpochs).toBe(epochs);
      expect(loadHubConfig({ ...TESTNET, ...delayEpochs(epochs) }).swaps.fiberPeerChannelCommitmentDelayEpochs).toBe(epochs);
    });

    it.each([0, 85])("refuses %i epochs whatever FIBER_ASSETS says (fnn takes 1 to 84)", (epochs) => {
      expect(() => withAssets([RUSD_ENTRY, CWBTC_ENTRY], delayEpochs(epochs))).toThrow(/^Invalid hub configuration: FIBER_PEER_CHANNEL_COMMITMENT_DELAY_EPOCHS/);
      expect(() => withAssets([CWBTC_WITH_PEERS], delayEpochs(epochs))).toThrow(/^Invalid hub configuration: FIBER_PEER_CHANNEL_COMMITMENT_DELAY_EPOCHS/);
    });
  });
});

describe("FIBER_PEER_CHANNELS_MAX_OPEN (fiberPeers.peerChannels.maxOpen)", () => {
  const MAX_OPEN = "FIBER_PEER_CHANNELS_MAX_OPEN";
  const maxOpenOf = (value?: string): number => loadHubConfig(value === undefined ? {} : { [MAX_OPEN]: value }).fiberPeers.peerChannels.maxOpen;
  /** The hub.env the testnet kit starts from, as `testnet env` copies it to the server. */
  const deployHubEnv = (): Record<string, string> =>
    parseEnv(readFileSync(join(__dirname, "..", "..", "..", "deploy", "testnet", "hub.env.example"), "utf8")) as Record<string, string>;

  it("defaults to 10", () => {
    expect(maxOpenOf()).toBe(10);
  });

  it("is read as given", () => {
    expect(maxOpenOf("3")).toBe(3);
    expect(maxOpenOf("250")).toBe(250);
  });

  it("accepts 0 (GET /v1/fiber/node then offers no peer channels at all)", () => {
    expect(maxOpenOf("0")).toBe(0);
  });

  it("sits next to the terms, whatever FIBER_ASSETS says", () => {
    const config = withAssets([CWBTC_WITH_PEERS], { [MAX_OPEN]: "4" });

    expect(config.fiberPeers.peerChannels).toEqual({ terms: { CWBTC: { minAmount: MIN_PEER_CWBTC } }, maxOpen: 4 });
  });

  it.each([
    ["a negative count", "-1"],
    ["a fractional count", "1.5"],
    ["a word", "ten"],
    ["a number with a unit", "10 channels"],
    ["a count too large to be a whole number", "1e400"],
  ])("refuses %s, naming the variable", (_label, value) => {
    expect(() => maxOpenOf(value)).toThrow(new RegExp(`^Invalid hub configuration: .*${MAX_OPEN}`));
  });

  it("is documented in .env.example with the default the code uses", () => {
    const documented = readEnvExample()[MAX_OPEN];

    expect(documented).toBeDefined();
    expect(maxOpenOf(documented)).toBe(maxOpenOf());
  });

  it("loads the value deploy/testnet/hub.env.example sets, with the rest of that file (and the public address compose adds)", () => {
    const hubEnv = deployHubEnv();
    expect(hubEnv[MAX_OPEN]).toBeDefined();

    const config = loadHubConfig({ ...hubEnv, FIBER_PUBLIC_WS_ADDRS: "/ip4/203.0.113.7/tcp/8228/ws" });

    expect(config.fiberPeers.peerChannels.maxOpen).toBe(Number(hubEnv[MAX_OPEN]));
  });
});
