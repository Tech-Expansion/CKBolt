import type { Token } from "@/lib/tokens";
import { knownToken, safeIconUrl, tokenLook } from "@/lib/token-display";
import type { AssetDto, Direction } from "./contract";

/** An asset the hub serves, with the token the app shows for it. */
export interface LiveAsset {
  dto: AssetDto;
  token: Token;
}

/**
 * The app's token for a hub asset: the known one with the hub's decimals, or one built from the DTO. Its name and
 * icon follow tokenLook: the hub's display name and icon when it sets them, else the app's, else the hub's name and
 * the initials (lib/token-display.ts).
 */
export function tokenForAsset(asset: AssetDto, known: readonly Token[]): Token {
  const match = knownToken(asset.symbol, known);
  const look = tokenLook(asset.symbol, asset, known);
  const iconUrl = safeIconUrl(asset.iconUrl) ?? undefined;
  const base: Token = match ?? { symbol: asset.symbol, name: look.name, decimals: asset.decimals, priceNote: "Priced by the hub", usdPrice: () => null, status: "Not quoted" };
  if (base.decimals === asset.decimals && base.name === look.name && !iconUrl) return base;
  return { ...base, decimals: asset.decimals, name: look.name, ...(iconUrl ? { iconUrl } : {}) };
}

export const toLiveAssets = (assets: readonly AssetDto[], known: readonly Token[]): LiveAsset[] =>
  assets.map((dto) => ({ dto, token: tokenForAsset(dto, known) }));

/** What copy calls the Fiber side's assets when no hub has listed its own yet. */
export const FIBER_ASSETS_FALLBACK = "CKB tokens";

/**
 * The hub's assets as one phrase for copy, in the hub's order and with its symbols: "CKB, RUSD, and cWBTC" (`and`) or
 * "CKB, RUSD, or cWBTC" (`or`); FIBER_ASSETS_FALLBACK while none is known.
 */
export function assetPhrase(symbols: readonly string[], joiner: "and" | "or" = "and"): string {
  if (symbols.length === 0) return FIBER_ASSETS_FALLBACK;
  return new Intl.ListFormat("en-US", { style: "long", type: joiner === "and" ? "conjunction" : "disjunction" }).format(symbols);
}

/** The assets the hub serves in one direction. */
export const assetsServing = (assets: readonly LiveAsset[], direction: Direction): LiveAsset[] =>
  assets.filter((a) => a.dto.directions.includes(direction));
