import type { FiberLiquidity } from "@/components/app/swap/contracts";
import type { AssetDto, FiberAssetId } from "@/lib/hub/contract";
import { isFiberAssetId } from "@/lib/hub/constants";
import { formatUnits } from "@/lib/hub/format";
import type { NodePresence } from "@/lib/wallets/fiber-browser/bridge-protocol";

const BASE_UNITS = /^\d{1,30}$/;

/** At most this many assets are read from a node tab's liquidity: far more than a hub serves, few enough to bound the work. */
export const MAX_LIQUIDITY_ASSETS = 32;

/**
 * The node tab's liquidity, kept only where the key is a well-formed asset id and both sides are whole base units: the
 * bridge carries what any page of the site posted, so nothing else is trusted. Which of these assets a swap may use is
 * the hub's list (the card reads the assets GET /v1/assets serves), not this one.
 */
export function readLiquidity(raw: NodePresence["liquidity"]): FiberLiquidity {
  const liquidity: FiberLiquidity = {};
  for (const [id, entry] of Object.entries(raw).slice(0, MAX_LIQUIDITY_ASSETS)) {
    if (!isFiberAssetId(id) || !entry || typeof entry !== "object") continue;
    const { send, receive } = entry as { send?: unknown; receive?: unknown };
    if (typeof send === "string" && typeof receive === "string" && BASE_UNITS.test(send) && BASE_UNITS.test(receive)) liquidity[id] = { send, receive };
  }
  return liquidity;
}

/** True when the node has a ready channel in some asset: something to send or room to receive. */
export function hasChannel(liquidity: FiberLiquidity): boolean {
  return Object.values(liquidity).some((entry) => entry !== undefined && (BigInt(entry.send) > BigInt(0) || BigInt(entry.receive) > BigInt(0)));
}

/** One asset's line of "what your node can move now", amounts formatted in whole units. */
export interface LiquidityRow {
  id: FiberAssetId;
  symbol: string;
  send: string;
  receive: string;
}

/** The node's liquidity in the assets the hub swaps, in the hub's order; assets the node did not report are left out. */
export function liquidityRows(liquidity: FiberLiquidity | null, assets: readonly Pick<AssetDto, "id" | "symbol" | "decimals">[]): LiquidityRow[] {
  if (!liquidity) return [];
  return assets.flatMap((asset) => {
    const entry = liquidity[asset.id];
    return entry
      ? [{ id: asset.id, symbol: asset.symbol, send: formatUnits(entry.send, asset.decimals), receive: formatUnits(entry.receive, asset.decimals) }]
      : [];
  });
}
