import { createAssetRegistry, knownUdtAssets } from "../../../src/domain/assets";
import type { FiberAsset } from "../../../src/domain/types";
import { CWBTC_CELL_DEP, CWBTC_SCRIPT, RUSD_CELL_DEP, RUSD_SCRIPT } from "./assets.fixtures";

/** The asset registry: built from the configured UDTs (HubConfig.ckb.udtAssets), CKB always first. */

const CWBTC: FiberAsset = {
  id: "CWBTC",
  symbol: "cWBTC",
  name: "CCH Wrapped BTC",
  decimals: 8,
  udtTypeScript: CWBTC_SCRIPT,
  usdRule: "btc_parity",
  cellDeps: [CWBTC_CELL_DEP],
};
const TOKEN6: FiberAsset = {
  id: "TOKEN6",
  symbol: "TK6",
  name: "A six-decimal token",
  decimals: 6,
  udtTypeScript: { codeHash: `0x${"66".repeat(32)}`, hashType: "data1", args: "0x06" },
  usdRule: "usd_peg",
  cellDeps: [{ typeId: { codeHash: `0x${"00".repeat(32)}`, hashType: "type", args: "0x07" } }],
};

describe("createAssetRegistry", () => {
  const registry = createAssetRegistry("testnet", [CWBTC, TOKEN6]);

  it("lists CKB first, then the configured UDTs in their order", () => {
    expect(registry.list().map((asset) => asset.id)).toEqual(["CKB", "CWBTC", "TOKEN6"]);
    expect(registry.get("CKB")).toEqual({ id: "CKB", symbol: "CKB", name: "Nervos CKB", decimals: 8, udtTypeScript: null, usdRule: "ckb_market", cellDeps: [] });
  });

  it("finds an asset by id, and nothing for an id it does not serve", () => {
    expect(registry.get("TOKEN6")).toEqual(TOKEN6);
    expect(registry.get("RUSD")).toBeNull();
  });

  it("finds an asset by its type script whatever the hex case, CKB by none", () => {
    expect(registry.byTypeScript({ ...CWBTC_SCRIPT, args: CWBTC_SCRIPT.args.toUpperCase().replace("0X", "0x") })?.id).toBe("CWBTC");
    expect(registry.byTypeScript(null)?.id).toBe("CKB");
    expect(registry.byTypeScript(RUSD_SCRIPT)).toBeNull();
  });

  it("serves CKB only on mainnet, whatever it is given (UDTs are out of scope there)", () => {
    expect(createAssetRegistry("mainnet", [CWBTC]).list().map((asset) => asset.id)).toEqual(["CKB"]);
  });

  it("hands out copies: a caller cannot change what the registry serves", () => {
    registry.list().pop();
    expect(registry.list()).toHaveLength(3);
  });
});

describe("knownUdtAssets (the legacy variables' UDTs)", () => {
  it("names RUSD and CWBTC as before, RUSD first, and knows the cell dep of Fiber's testnet RUSD only", () => {
    expect(knownUdtAssets({ CWBTC: CWBTC_SCRIPT, RUSD: RUSD_SCRIPT })).toEqual([
      { id: "RUSD", symbol: "RUSD", name: "RUSD stablecoin", decimals: 8, udtTypeScript: RUSD_SCRIPT, usdRule: "usd_peg", cellDeps: [RUSD_CELL_DEP] },
      { id: "CWBTC", symbol: "cWBTC", name: "Test wrapped BTC", decimals: 8, udtTypeScript: CWBTC_SCRIPT, usdRule: "btc_parity", cellDeps: [] },
    ]);
  });

  it("leaves out a UDT without a script", () => {
    expect(knownUdtAssets({})).toEqual([]);
  });
});
