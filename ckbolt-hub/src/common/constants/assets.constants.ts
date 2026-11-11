import type { AssetUsdRule, CellDep, FiberAsset, Script } from "../../domain/types";

/**
 * Facts about Fiber assets. Which UDTs the hub serves is config (FIBER_ASSETS, src/config/fiber-assets.config.ts); CKB is
 * always served. The metadata below is CKB's, and the defaults of the UDTs the legacy variables UDT_RUSD_SCRIPT and
 * UDT_CWBTC_SCRIPT configure when FIBER_ASSETS is not set.
 */

/** The USD value rules by name, so code never spells the strings inline. */
export const ASSET_USD_RULE = {
  CKB_MARKET: "ckb_market",
  USD_PEG: "usd_peg",
  BTC_PARITY: "btc_parity",
} as const satisfies Record<string, AssetUsdRule>;

/** The rules a configured UDT may use: `ckb_market` is CKB's own. */
export const UDT_USD_RULES = [ASSET_USD_RULE.USD_PEG, ASSET_USD_RULE.BTC_PARITY] as const;

/** The id of native CKB, the asset every hub serves. */
export const CKB_ASSET_ID = "CKB";

/** What the API calls the Lightning leg's asset (LegDto.asset), so no Fiber asset may take the name. */
export const LIGHTNING_ASSET_ID = "BTC";

/** A Fiber asset id: an upper-case letter, then 1 to 15 upper-case letters or digits ("CKB", "RUSD", "CWBTC"). */
export const ASSET_ID_PATTERN = /^[A-Z][A-Z0-9]{1,15}$/;

/** Ids FIBER_ASSETS cannot give a UDT: CKB is built in, BTC names the Lightning leg. */
export const RESERVED_ASSET_IDS: readonly string[] = [CKB_ASSET_ID, LIGHTNING_ASSET_ID];

/** Most decimals a configured UDT may have; base units are u128 on Fiber. */
export const FIBER_ASSET_MAX_DECIMALS = 18;

/** How a cell dep's code is referenced (CKB's dep_type). */
export const CELL_DEP_TYPES = ["code", "dep_group"] as const;

/** The assets the hub has metadata for without FIBER_ASSETS: CKB and the UDTs of the legacy variables. */
export type KnownAssetId = "CKB" | "RUSD" | "CWBTC";
export type KnownUdtId = Exclude<KnownAssetId, "CKB">;

/** The legacy UDTs in the order the hub lists them. */
export const KNOWN_UDT_IDS: readonly KnownUdtId[] = ["RUSD", "CWBTC"];

/** Display metadata and USD rule of the known assets. Type scripts are per network and come from config. */
export const ASSET_METADATA: Readonly<Record<KnownAssetId, Pick<FiberAsset, "symbol" | "name" | "decimals" | "usdRule">>> = {
  CKB: { symbol: "CKB", name: "Nervos CKB", decimals: 8, usdRule: ASSET_USD_RULE.CKB_MARKET },
  RUSD: { symbol: "RUSD", name: "RUSD stablecoin", decimals: 8, usdRule: ASSET_USD_RULE.USD_PEG },
  CWBTC: { symbol: "cWBTC", name: "Test wrapped BTC", decimals: 8, usdRule: ASSET_USD_RULE.BTC_PARITY },
};

/** Native CKB: no type script, no cell deps, valued at its market price. */
export const CKB_ASSET: Readonly<FiberAsset> = { id: CKB_ASSET_ID, ...ASSET_METADATA.CKB, udtTypeScript: null, cellDeps: [] };

/** RUSD on CKB testnet, from Fiber's default testnet UDT whitelist (fnn v0.9.1 config/testnet/config.yml). */
export const TESTNET_RUSD_TYPE_SCRIPT: Script = {
  codeHash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hashType: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};

/** The cell dep of RUSD on CKB testnet in the same whitelist: its xUDT code cell, by type id. */
export const TESTNET_RUSD_CELL_DEPS: readonly CellDep[] = [
  {
    typeId: {
      codeHash: "0x00000000000000000000000000000000000000000000000000545950455f4944",
      hashType: "type",
      args: "0x97d30b723c0b2c66e9cb8d4d0df4ab5d7222cbb00d4a9a2055ce2e5d7f0d8b0f",
    },
  },
];

/** Longest `displayName` FIBER_ASSETS takes for a UDT: the name the web app shows for it. */
export const ASSET_DISPLAY_NAME_MAX_LENGTH = 64;

/**
 * An asset's `iconUrl` (FIBER_ASSETS) is an https URL, or a small inline SVG as a base64 data URL. Inline icons need no
 * request to another host, so they also load on the web app's cross-origin isolated node page (COEP require-corp),
 * which blocks images from hosts that send no Cross-Origin-Resource-Policy header.
 */
export const ICON_URL_RULE = {
  HTTPS_PROTOCOL: "https:",
  /** Longest https icon URL. */
  MAX_URL_LENGTH: 2_048,
  /** The only inline form taken: an SVG image, base64. */
  SVG_DATA_URL_PREFIX: "data:image/svg+xml;base64,",
  /** Longest inline icon, the whole data URL: it travels in every GET /v1/assets answer and in one env line. */
  MAX_DATA_URL_LENGTH: 8_192,
  /** How a decoded inline SVG starts: an XML declaration, a comment, or the svg element. */
  SVG_START: /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i,
  /**
   * What an inline SVG must not contain: scripts, event handlers, links and animations that can set them, embedded
   * documents, DTDs, character references (which can spell any of these), and any reference outside the image (an href
   * or url() that is not a #fragment, @import). A browser runs none of it in an <img>, which is how the icon must be
   * shown; this deny-list is defence in depth, not a sanitizer for inlined markup.
   */
  SVG_FORBIDDEN:
    /<script|<foreignObject|<iframe|<embed|<object|<a[\s>]|<set[\s>]|<animate|<!DOCTYPE|<!ENTITY|&#|\bon[a-z]+\s*=|javascript:|(?<![\w-])(?:xlink:)?href\s*=(?!\s*["']?\s*#)|url\((?!\s*["']?\s*#)|@import/i,
} as const;
