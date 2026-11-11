import { normalizeAmountInput, type DecimalMark } from "@/lib/amount";
import type { AssetDto, FiberAssetId, FiberNodeDto, Script } from "@/lib/hub/contract";
import { FIBER_NODE_ID_PATTERN } from "@/lib/hub/constants";
import { formatUnits } from "@/lib/hub/format";
import { CKB_ASSET } from "./channels";
import { normalizeNodeId } from "./hex";
import { CKB_DECIMALS } from "./constants";

/**
 * The tokens the browser node holds and moves (CKB and the tokens the hub lists), and amounts and node ids as the
 * visitor types them and the node shows them.
 */

/** A token the node moves: CKB, or a token whose script the hub lists for this node's network. */
export interface WalletToken {
  id: FiberAssetId;
  symbol: string;
  decimals: number;
  /** null for CKB. */
  udtTypeScript: Script | null;
}

/**
 * The decimals of `asset`: CKB's own, or what the hub lists for it (GET /v1/assets, which lists every asset it
 * serves); null for a token it does not list, or while that list is unknown, so no amount is read or shown at a guessed
 * scale (tokens may have any decimals the hub's config gives them, 0 to 18).
 */
export function assetDecimals(asset: FiberAssetId, assets: readonly Pick<AssetDto, "id" | "decimals">[]): number | null {
  if (asset === CKB_ASSET) return CKB_DECIMALS;
  return assets.find((a) => a.id === asset)?.decimals ?? null;
}

/**
 * The tokens the node offers: CKB always, then each token the hub's Fiber node lists with its script (only a hub on
 * the node's network is passed in), with the symbol and decimals of GET /v1/assets when the hub gives them. The node's
 * own checks (pay-requests.ts) need only the ids and scripts, so a token missing from `assets` keeps CKB's decimals
 * there; views take shownTokens, which leaves such a token out.
 */
export function walletTokens(hubNode: Pick<FiberNodeDto, "assets"> | null, assets: readonly Pick<AssetDto, "id" | "symbol" | "decimals">[]): WalletToken[] {
  const scripts = new Map<FiberAssetId, Script | null>([[CKB_ASSET, null]]);
  for (const asset of hubNode?.assets ?? []) if (asset.udtTypeScript && !scripts.has(asset.id)) scripts.set(asset.id, asset.udtTypeScript);
  return [...scripts].map(([id, udtTypeScript]) => {
    const listed = assets.find((a) => a.id === id);
    return { id, symbol: listed?.symbol ?? id, decimals: assetDecimals(id, assets) ?? CKB_DECIMALS, udtTypeScript };
  });
}

/**
 * The tokens a view offers and shows: walletTokens, less any token whose decimals the hub has not given (GET /v1/assets
 * did not answer), whose amounts could not be typed or shown without a guess. It comes back once the hub lists it.
 */
export const shownTokens = (hubNode: Pick<FiberNodeDto, "assets"> | null, assets: readonly Pick<AssetDto, "id" | "symbol" | "decimals">[]): WalletToken[] =>
  walletTokens(hubNode, assets).filter((token) => assetDecimals(token.id, assets) !== null);

/** "12.5 RUSD": base units of a token as an exact grouped decimal with its symbol. */
export const formatTokenAmount = (amount: bigint | string, token: Pick<WalletToken, "decimals" | "symbol">): string =>
  `${formatUnits(amount.toString(), token.decimals)} ${token.symbol}`;

const groupThousands = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * "12.5 cWBTC" with known decimals; with unknown ones (null) the base units themselves, so nothing is scaled by a
 * guess: "1,250,000,000 base units of cWBTC".
 */
export const formatAssetUnits = (amount: bigint | string, decimals: number | null, symbol: string): string =>
  decimals === null ? `${groupThousands(amount.toString())} base units of ${symbol}` : `${formatUnits(amount.toString(), decimals)} ${symbol}`;

/** 10^n exactly, as a bigint. */
const pow10 = (n: number): bigint => BigInt(`1${"0".repeat(n)}`);

/**
 * Base units as a short figure, for a label with little room: grouped, at most `fractionDigits` decimals, rounded down
 * (so it never shows more than there is). "110123456789" with 8 decimals and 2 digits is "1,101.23".
 */
export function formatShortUnits(amount: bigint | string, decimals: number, fractionDigits: number): string {
  const units = BigInt(amount);
  const scale = pow10(decimals);
  const whole = units / scale;
  const shown = Math.min(fractionDigits, decimals);
  const fraction = ((units % scale) / pow10(decimals - shown)).toString().padStart(shown, "0").replace(/0+$/, "");
  return fraction ? `${groupThousands(whole.toString())}.${fraction}` : groupThousands(whole.toString());
}

/**
 * An amount the visitor typed, as base units of a token with `decimals`; null when it is not a positive amount the
 * token can hold (more decimals than it has, or nothing). The decimal mark follows the browser's locale (lib/amount.ts).
 */
export function parseTokenAmount(text: string, decimals: number, decimalMark?: DecimalMark): bigint | null {
  const normalized = normalizeAmountInput(text, decimalMark);
  if (normalized === null) return null;
  const [whole, fraction = ""] = normalized.split(".");
  // More decimals than the token has would be rounded away: refuse them instead.
  if (fraction.length > decimals) return null;
  const units = BigInt(`${whole || "0"}${fraction.padEnd(decimals, "0")}`);
  return units > BigInt(0) ? units : null;
}

/** A node id typed by the visitor, as fnn's RPC takes it (66 lower-case hex characters, no 0x), or null. */
export const parseNodeId = (text: string): string | null => (FIBER_NODE_ID_PATTERN.test(text.trim()) ? normalizeNodeId(text) : null);

/** A form's input as a value, or the field that is wrong and why. */
export type FormCheck<T, F extends string> = { ok: true; value: T } | { ok: false; field: F; error: string };
