import { assetRegistryOf, loadHubConfig } from "../../../src/config/hub.config";
import {
  CWBTC_CELL_DEP,
  CWBTC_ENTRY,
  CWBTC_MAX_SATS,
  CWBTC_SCRIPT,
  INBOUND_CKB,
  INBOUND_CWBTC,
  INBOUND_RUSD,
  ONE_WHOLE,
  P2P_ADDR,
  RUSD_CELL_DEP,
  RUSD_ENTRY,
  RUSD_SCRIPT,
} from "./assets.fixtures";

/**
 * FIBER_ASSETS: the UDTs a hub serves, as one validated JSON variable, and the legacy variables it replaces
 * (UDT_RUSD_SCRIPT, UDT_CWBTC_SCRIPT, FIBER_INBOUND_RUSD_AMOUNT), which keep a hub without FIBER_ASSETS working as before.
 */

const TESTNET = { CKB_NETWORK: "testnet" };
const assetsJson = (...entries: unknown[]): string => JSON.stringify(entries);
const withAssets = (entries: unknown[], env: Record<string, string> = {}) => loadHubConfig({ ...TESTNET, FIBER_ASSETS: JSON.stringify(entries), ...env });
const ids = (env: Record<string, string>) =>
  assetRegistryOf(loadHubConfig(env))
    .list()
    .map((asset) => asset.id);
const INBOUND_ON = { FIBER_INBOUND_ENABLED: "true", FIBER_PUBLIC_P2P_ADDRS: P2P_ADDR };
const DEVNET_RUSD = { codeHash: `0x${"12".repeat(32)}`, hashType: "type", args: `0x${"34".repeat(32)}` };

describe("FIBER_ASSETS", () => {
  describe("a valid list (the VPS example: RUSD and cWBTC on testnet)", () => {
    const config = withAssets([RUSD_ENTRY, CWBTC_ENTRY], { ...INBOUND_ON, FIBER_INBOUND_CKB_AMOUNT: INBOUND_CKB.toString() });

    it("serves CKB first, then the listed UDTs in their order, each as configured", () => {
      expect(assetRegistryOf(config).list()).toEqual([
        { id: "CKB", symbol: "CKB", name: "Nervos CKB", decimals: 8, udtTypeScript: null, usdRule: "ckb_market", cellDeps: [] },
        { id: "RUSD", symbol: "RUSD", name: "RUSD stablecoin", decimals: 8, udtTypeScript: RUSD_SCRIPT, usdRule: "usd_peg", cellDeps: [RUSD_CELL_DEP] },
        { id: "CWBTC", symbol: "cWBTC", name: "CCH Wrapped BTC", decimals: 8, udtTypeScript: CWBTC_SCRIPT, usdRule: "btc_parity", cellDeps: [CWBTC_CELL_DEP] },
      ]);
    });

    it("keeps only the terms an entry sets; the global values stay the defaults", () => {
      expect(config.pricing.termsByAsset).toEqual({ CWBTC: { optionPremiumBps: 0, maxSats: CWBTC_MAX_SATS } });
      expect(config.pricing).toMatchObject({ feeBps: 50, optionPremiumBps: 50, minSats: 1_000n, maxSats: 100_000n });
    });

    it("offers an inbound channel per asset with an amount, and the auto-accept amount a browser node whitelists", () => {
      expect(config.fiberPeers.inboundChannels.amounts).toEqual({ CKB: INBOUND_CKB, RUSD: INBOUND_RUSD, CWBTC: INBOUND_CWBTC });
      expect(config.fiberPeers.inboundChannels.autoAcceptAmounts).toEqual({ RUSD: INBOUND_RUSD, CWBTC: INBOUND_CWBTC });
    });

    it("accepts amounts as JSON numbers and an out-point index as a number, normalised to a hex quantity", () => {
      const entry = { ...CWBTC_ENTRY, inboundAmount: 500_000_000, autoAcceptAmount: 400_000_000, cellDeps: [{ ...CWBTC_CELL_DEP, outPoint: { txHash: `0x${"bf".repeat(32)}`, index: 10 } }] };
      const loaded = withAssets([entry], INBOUND_ON);

      expect(loaded.fiberPeers.inboundChannels.autoAcceptAmounts).toEqual({ CWBTC: 400_000_000n });
      expect(loaded.ckb.udtAssets[0]?.cellDeps).toEqual([{ outPoint: { txHash: `0x${"bf".repeat(32)}`, index: "0xa" }, depType: "code" }]);
    });
  });

  it("normalises a type script's and a cell dep's hex to lower case, as fnn matches the whitelist", () => {
    const DEP_TX = "0xbf6fb538763efec2a70a6a3dcb7242787087e1030c4e7d86585bc63a9d337f5f";
    const upper = (hex: string): string => `0x${hex.slice(2).toUpperCase()}`;
    const entry = {
      ...CWBTC_ENTRY,
      typeScript: { ...CWBTC_SCRIPT, codeHash: upper(CWBTC_SCRIPT.codeHash), args: upper(CWBTC_SCRIPT.args) },
      cellDeps: [{ outPoint: { txHash: upper(DEP_TX), index: "0x0" }, depType: "code" }],
    };
    const asset = assetRegistryOf(withAssets([entry])).get("CWBTC");

    expect(asset?.udtTypeScript).toEqual(CWBTC_SCRIPT);
    expect(asset?.cellDeps).toEqual([CWBTC_CELL_DEP]);
  });

  it("takes any upper-case id, so a new UDT needs no code change", () => {
    const tusd = { ...RUSD_ENTRY, id: "TUSD2", symbol: "tUSD", typeScript: { ...RUSD_SCRIPT, args: "0x01" } };

    expect(assetRegistryOf(withAssets([tusd])).get("TUSD2")).toMatchObject({ symbol: "tUSD", usdRule: "usd_peg" });
  });

  it("[] serves CKB only, with no fallback to Fiber's testnet RUSD", () => {
    expect(ids({ ...TESTNET, FIBER_ASSETS: "[]" })).toEqual(["CKB"]);
  });

  it("an empty FIBER_ASSETS= counts as not set (the legacy variables apply)", () => {
    expect(ids({ ...TESTNET, FIBER_ASSETS: " " })).toEqual(["CKB", "RUSD"]);
  });

  describe("refuses, naming FIBER_ASSETS", () => {
    it.each([
      ["text that is not JSON", "not json"],
      ["an object instead of a list", JSON.stringify(CWBTC_ENTRY)],
      ["a misspelt key", assetsJson({ ...CWBTC_ENTRY, optionPremium: 0 })],
      ["a lower-case id", assetsJson({ ...CWBTC_ENTRY, id: "cwbtc" })],
      ["the reserved id CKB", assetsJson({ ...CWBTC_ENTRY, id: "CKB" })],
      ["the reserved id BTC", assetsJson({ ...CWBTC_ENTRY, id: "BTC" })],
      ["ckb_market for a UDT", assetsJson({ ...CWBTC_ENTRY, usdRule: "ckb_market" })],
      ["an unknown USD rule", assetsJson({ ...CWBTC_ENTRY, usdRule: "eur_peg" })],
      ["no cell deps", assetsJson({ ...CWBTC_ENTRY, cellDeps: [] })],
      ["a cell dep without dep type", assetsJson({ ...CWBTC_ENTRY, cellDeps: [{ outPoint: CWBTC_CELL_DEP }] })],
      ["a short type script code hash", assetsJson({ ...CWBTC_ENTRY, typeScript: { ...CWBTC_SCRIPT, codeHash: "0x25c2" } })],
      ["too many decimals", assetsJson({ ...CWBTC_ENTRY, decimals: 19 })],
      ["a negative fee", assetsJson({ ...CWBTC_ENTRY, feeBps: -1 })],
      ["a fractional amount", assetsJson({ ...CWBTC_ENTRY, inboundAmount: "1.5" })],
      ["an amount past the safe integer range as a JSON number", `[${JSON.stringify(CWBTC_ENTRY).replace('"inboundAmount":"1000000000"', '"inboundAmount":90071992547409930')}]`],
      ["an auto-accept amount above the inbound amount", assetsJson({ ...CWBTC_ENTRY, autoAcceptAmount: (INBOUND_CWBTC + 1n).toString() })],
      ["an auto-accept amount without an inbound amount", assetsJson({ ...CWBTC_ENTRY, inboundAmount: undefined })],
      ["the same id twice", assetsJson(CWBTC_ENTRY, { ...CWBTC_ENTRY, typeScript: RUSD_SCRIPT })],
      ["the same type script twice (hex case aside)", assetsJson(CWBTC_ENTRY, { ...CWBTC_ENTRY, id: "CWBTC2", typeScript: { ...CWBTC_SCRIPT, args: CWBTC_SCRIPT.args.toUpperCase().replace("0X", "0x") } })],
    ])("%s", (_label, value) => {
      expect(() => loadHubConfig({ ...TESTNET, FIBER_ASSETS: value })).toThrow(/^Invalid hub configuration: FIBER_ASSETS/);
    });
  });

  describe("per-asset terms keep the global rules", () => {
    it("refuses an asset fee that the payout routing budgets would eat (LN_MAX_FEE_BPS, FIBER_MAX_FEE_BPS 25)", () => {
      expect(() => withAssets([{ ...CWBTC_ENTRY, feeBps: 25 }])).toThrow(/^Invalid hub configuration: LN_MAX_FEE_BPS \(25\) must be below the feeBps of CWBTC/);
      expect(() => withAssets([{ ...CWBTC_ENTRY, feeBps: 26 }])).not.toThrow();
    });

    it("refuses an asset whose minSats ends up above its maxSats, its own or the global one", () => {
      expect(() => withAssets([{ ...CWBTC_ENTRY, minSats: "30000" }])).toThrow(/CWBTC would swap from 30000 to 20000 sats/);
      expect(() => withAssets([{ ...RUSD_ENTRY, minSats: "200000" }])).toThrow(/RUSD would swap from 200000 to 100000 sats/);
      expect(withAssets([{ ...CWBTC_ENTRY, minSats: "0" }]).pricing.termsByAsset.CWBTC).toMatchObject({ minSats: 0n });
    });
  });

  it("replaces the legacy variables: setting both is refused, naming the ones to remove", () => {
    const both = { ...TESTNET, FIBER_ASSETS: assetsJson(CWBTC_ENTRY), UDT_RUSD_SCRIPT: JSON.stringify(RUSD_SCRIPT), FIBER_INBOUND_RUSD_AMOUNT: "100" };

    expect(() => loadHubConfig(both)).toThrow(/FIBER_ASSETS replaces UDT_RUSD_SCRIPT, FIBER_INBOUND_RUSD_AMOUNT: remove them/);
    expect(() => loadHubConfig({ ...TESTNET, FIBER_ASSETS: "[]", UDT_CWBTC_SCRIPT: JSON.stringify(CWBTC_SCRIPT) })).toThrow(/replaces UDT_CWBTC_SCRIPT: remove it/);
  });

  it("serves no UDT on mainnet: a non-empty list is refused, [] is fine", () => {
    expect(() => loadHubConfig({ CKB_NETWORK: "mainnet", FIBER_ASSETS: assetsJson(CWBTC_ENTRY) })).toThrow(/serves no UDT on mainnet/);
    expect(ids({ CKB_NETWORK: "mainnet", FIBER_ASSETS: "[]" })).toEqual(["CKB"]);
  });

  it("lets inbound channels run on a UDT amount alone", () => {
    expect(withAssets([CWBTC_ENTRY], INBOUND_ON).fiberPeers.inboundChannels.amounts).toEqual({ CWBTC: INBOUND_CWBTC });
    expect(() => withAssets([{ ...CWBTC_ENTRY, inboundAmount: undefined, autoAcceptAmount: undefined }], INBOUND_ON)).toThrow(
      /FIBER_INBOUND_ENABLED needs FIBER_INBOUND_CKB_AMOUNT or a UDT's inboundAmount in FIBER_ASSETS/,
    );
  });

  it("still holds CKB inbound channels to the 199 CKB a default node auto-accepts", () => {
    expect(() => withAssets([CWBTC_ENTRY], { ...INBOUND_ON, FIBER_INBOUND_CKB_AMOUNT: String(198n * ONE_WHOLE) })).toThrow(/FIBER_INBOUND_CKB_AMOUNT/);
  });
});

describe("without FIBER_ASSETS: the legacy variables, unchanged behaviour", () => {
  it("testnet with nothing set: CKB and Fiber's testnet RUSD, with its whitelist cell dep, at the global terms", () => {
    const config = loadHubConfig(TESTNET);

    expect(assetRegistryOf(config).list()).toEqual([
      expect.objectContaining({ id: "CKB" }),
      { id: "RUSD", symbol: "RUSD", name: "RUSD stablecoin", decimals: 8, udtTypeScript: RUSD_SCRIPT, usdRule: "usd_peg", cellDeps: [RUSD_CELL_DEP] },
    ]);
    expect(config.pricing.termsByAsset).toEqual({});
  });

  it("devnet with nothing set: CKB only", () => {
    expect(ids({})).toEqual(["CKB"]);
  });

  it("UDT_RUSD_SCRIPT and UDT_CWBTC_SCRIPT serve their UDTs with today's names; cell deps only where the hub knows them", () => {
    const assets = assetRegistryOf(loadHubConfig({ UDT_RUSD_SCRIPT: JSON.stringify(DEVNET_RUSD), UDT_CWBTC_SCRIPT: JSON.stringify(CWBTC_SCRIPT) })).list();

    expect(assets.map(({ id, symbol, name, usdRule, cellDeps }) => ({ id, symbol, name, usdRule, cellDeps }))).toEqual([
      { id: "CKB", symbol: "CKB", name: "Nervos CKB", usdRule: "ckb_market", cellDeps: [] },
      { id: "RUSD", symbol: "RUSD", name: "RUSD stablecoin", usdRule: "usd_peg", cellDeps: [] },
      { id: "CWBTC", symbol: "cWBTC", name: "Test wrapped BTC", usdRule: "btc_parity", cellDeps: [] },
    ]);
  });

  it("FIBER_INBOUND_RUSD_AMOUNT offers RUSD inbound channels, auto-accepted at that amount", () => {
    const config = loadHubConfig({ ...TESTNET, ...INBOUND_ON, FIBER_INBOUND_RUSD_AMOUNT: INBOUND_RUSD.toString() });

    expect(config.fiberPeers.inboundChannels.amounts).toEqual({ RUSD: INBOUND_RUSD });
    expect(config.fiberPeers.inboundChannels.autoAcceptAmounts).toEqual({ RUSD: INBOUND_RUSD });
  });

  it("still refuses FIBER_INBOUND_RUSD_AMOUNT where RUSD is not served", () => {
    expect(() => loadHubConfig({ ...INBOUND_ON, FIBER_INBOUND_RUSD_AMOUNT: INBOUND_RUSD.toString() })).toThrow(
      /FIBER_INBOUND_RUSD_AMOUNT is set, but the hub does not serve RUSD on devnet/,
    );
  });

  it("mainnet ignores the UDT scripts, as before: CKB only", () => {
    expect(ids({ CKB_NETWORK: "mainnet", UDT_RUSD_SCRIPT: JSON.stringify(RUSD_SCRIPT), UDT_CWBTC_SCRIPT: JSON.stringify(CWBTC_SCRIPT) })).toEqual(["CKB"]);
  });
});
