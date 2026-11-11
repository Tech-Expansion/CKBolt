"use client";

import { useEffect, useState } from "react";
import type { Script } from "@/lib/hub/contract";
import type { CkbRpcClient } from "@/lib/wallets/fiber-browser/ckb-rpc";
import type { WalletToken } from "@/lib/wallets/fiber-browser/tokens";

/**
 * Base units of `token` the node holds on chain (its cells of the token at the node's address), read when the token is
 * chosen; null for CKB, before the node runs, while reading, or when the RPC cannot tell.
 */
export function useTokenBalance(rpc: CkbRpcClient, lock: Script | null, token: WalletToken): bigint | null {
  const [read, setRead] = useState<{ id: string; amount: bigint } | null>(null);
  const type = token.udtTypeScript;
  useEffect(() => {
    if (!lock || !type) return;
    let current = true;
    rpc.tokenAmount(lock, type).then(
      (amount) => current && setRead({ id: token.id, amount }),
      () => current && setRead(null),
    );
    return () => {
      current = false;
    };
  }, [rpc, lock, type, token.id]);
  return type && read?.id === token.id ? read.amount : null;
}
