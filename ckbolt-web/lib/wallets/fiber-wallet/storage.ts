import type { FiberWalletKind } from "@/components/app/swap/contracts";
import type { KeyValueStore } from "@/lib/wallets/fiber-browser/storage";
import { FIBER_WALLET_KIND_STORAGE_KEY, FIBER_WALLET_KINDS } from "./constants";

const isKind = (value: string | null): value is FiberWalletKind => FIBER_WALLET_KINDS.some((kind) => kind === value);

/** The kind chosen earlier in this tab, or null when none was, storage is blocked, or the value is not a kind. */
export function readFiberWalletKind(store: KeyValueStore | null): FiberWalletKind | null {
  try {
    const value = store?.getItem(FIBER_WALLET_KIND_STORAGE_KEY) ?? null;
    return isKind(value) ? value : null;
  } catch {
    return null;
  }
}

/** Remembers the chosen kind for this tab, or forgets it (null). Storage that refuses is ignored: the choice holds in memory. */
export function saveFiberWalletKind(store: KeyValueStore | null, kind: FiberWalletKind | null): void {
  try {
    if (kind) store?.setItem(FIBER_WALLET_KIND_STORAGE_KEY, kind);
    else store?.removeItem(FIBER_WALLET_KIND_STORAGE_KEY);
  } catch {
    // Private modes and blocked storage throw; the page keeps working without it.
  }
}
