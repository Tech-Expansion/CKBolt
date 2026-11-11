import type { RateSnapshot } from "./quote";

export interface Token {
  symbol: string;
  name: string;
  /** Path under /public. Missing means no official icon is published. */
  icon?: string;
  /**
   * The hub's icon for the asset (GET /v1/assets `iconUrl`, checked by lib/token-display.ts): an https URL or an inline
   * SVG, tried before `icon` (tokenIcons). Only for a token built from the hub's asset.
   */
  iconUrl?: string;
  /** How the token's USD value is derived. */
  priceNote: string;
  /** USD per whole token, or null when there is no reliable source. */
  usdPrice: (rate: RateSnapshot) => number | null;
  /** Decimal places of the token's base unit (CKB: shannons). */
  decimals: number;
  /** How the prototype prices this token. */
  status: "Reference price" | "Quoted at peg" | "Quoted 1:1 with BTC" | "Not quoted";
  /** CKB Explorer type hash, for xUDT tokens. */
  typeHash?: string;
}

/**
 * Tokens a CKB holder can pay with. Native CKB plus well-held xUDT tokens on
 * CKB mainnet (ranked by holders on CKB Explorer), and cWBTC, the test token a
 * CKBolt hub serves on CKB testnet. Icons are the ones the issuers registered
 * on CKB Explorer (cWBTC's is drawn for CKBolt); prices are only shown where a
 * source or a peg is defensible. USDI is not listed: it was discontinued on
 * CKB in August 2026, and RUSD is the stablecoin example. The app shows the
 * tokens a hub serves (GET /v1/assets); the hub's display name and icon come
 * first when it sets them, and a token not listed here shows from the hub's
 * own data (lib/hub/assets.ts, lib/token-display.ts).
 */
export const PAY_TOKENS: Token[] = [
  {
    symbol: "CKB",
    decimals: 8,
    name: "Nervos CKB",
    icon: "/tokens/ckb.svg",
    priceNote: "Reference market price",
    usdPrice: (r) => r.ckbUsd,
    status: "Reference price",
  },
  {
    symbol: "ccBTC",
    decimals: 8,
    name: "BTC on CKB",
    icon: "/tokens/ccbtc.png",
    priceNote: "Custodial BTC on CKB, valued 1:1 with BTC",
    usdPrice: (r) => r.btcUsd,
    status: "Quoted 1:1 with BTC",
    typeHash: "0x3cd44aecea36e0a27e671f1fc79e65add7bf2f0e8b368389dc810ec81c63fa57",
  },
  {
    symbol: "RUSD",
    decimals: 8,
    name: "Stable++ USD stablecoin",
    priceNote: "Valued at its $1 peg",
    usdPrice: () => 1,
    status: "Quoted at peg",
    typeHash: "0x71ff665b40ba044b1981ea9a8965189559c8e01e8cdfa34a3cc565e1f870a95c",
  },
  {
    symbol: "cWBTC",
    decimals: 8,
    name: "CCH Wrapped BTC (test)",
    icon: "/tokens/cwbtc.svg",
    priceNote: "Testnet only: 1 cWBTC counts as 1 BTC of test value",
    usdPrice: (r) => r.btcUsd,
    status: "Quoted 1:1 with BTC",
  },
  {
    symbol: "iCKB",
    decimals: 8,
    name: "Liquid Nervos DAO deposit",
    icon: "/tokens/ickb.png",
    priceNote: "No reliable price source yet",
    usdPrice: () => null,
    status: "Not quoted",
    typeHash: "0xd485c2271949c232e3f5d46128336c716f90bcbf3cb278696083689fbbcd407a",
  },
  {
    symbol: "STB",
    decimals: 8,
    name: "Stable++ token",
    icon: "/tokens/stb.png",
    priceNote: "No reliable price source yet",
    usdPrice: () => null,
    status: "Not quoted",
    typeHash: "0x7aaab7f33ff85618e9b1d88f57dc5607554cfd5ae347f295b47bd1f16ae84a1a",
  },
  {
    symbol: "Seal",
    decimals: 8,
    name: "RGB++ token",
    icon: "/tokens/seal.png",
    priceNote: "No reliable price source yet",
    usdPrice: () => null,
    status: "Not quoted",
    typeHash: "0x178fb47b597a56d48b549226aff59f750b4784250c7f40f781b64ef090a8a0a7",
  },
];

/** What the swap card's Lightning side shows: BTC is fixed there, not a picker. */
export const RECEIVE_TOKENS = {
  BTC: { symbol: "BTC", name: "Bitcoin on Lightning", icon: "/tokens/btc.png" },
} as const;
