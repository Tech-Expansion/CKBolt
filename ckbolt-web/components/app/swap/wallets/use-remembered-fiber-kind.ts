"use client";

import { useCallback, useEffect, useState } from "react";
import type { FiberWalletKind } from "../contracts";
import { webStore } from "@/lib/wallets/fiber-browser/storage";
import { readFiberWalletKind, saveFiberWalletKind } from "@/lib/wallets/fiber-wallet/storage";

/**
 * The chosen Fiber wallet kind, remembered in sessionStorage for this tab. Read after mount, so the server render and
 * the first client render agree (nothing chosen).
 */
export function useRememberedFiberKind(): [FiberWalletKind | null, (kind: FiberWalletKind | null) => void] {
  const [kind, setKind] = useState<FiberWalletKind | null>(null);

  useEffect(() => {
    const remembered = readFiberWalletKind(webStore("sessionStorage"));
    if (remembered) setKind(remembered);
  }, []);

  const remember = useCallback((next: FiberWalletKind | null) => {
    saveFiberWalletKind(webStore("sessionStorage"), next);
    setKind(next);
  }, []);

  return [kind, remember];
}
