import type { AssetRegistry } from "../../domain/assets";
import type { FiberAssetId, Swap } from "../../domain/types";

/** The distinct assets of `swaps`, in order of first use. */
const assetsOf = (swaps: readonly Swap[]): FiberAssetId[] => [...new Set(swaps.map((swap) => swap.asset))];

/**
 * Refuses to start while an open swap (any state but final, or failed with its incoming leg not yet cancelled) is in an
 * asset the hub no longer serves (docs/security-review-2026-11.md, H8): the engine reads and pays a Fiber leg by its
 * asset's type script, so such a swap could neither finish nor be refunded and its user's payment would stay held. The
 * operator puts the asset back (FIBER_ASSETS, or the legacy variable it came from) until those swaps have ended.
 */
export function assertOpenSwapAssetsServed(openSwaps: readonly Swap[], assets: AssetRegistry): void {
  const stranded = openSwaps.filter((swap) => assets.get(swap.asset) === null);
  if (stranded.length === 0) return;
  const removed = assetsOf(stranded).join(", ");
  throw new Error(
    `Invalid hub configuration: ${stranded.length} open swap(s) use ${removed}, which the hub no longer serves on ` +
      `CKB_NETWORK (swaps ${stranded.map((swap) => swap.id).join(", ")}). Put ${removed} back in FIBER_ASSETS (or the ` +
      "legacy variable it came from) and restart; remove it again once those swaps have succeeded or been refunded.",
  );
}
