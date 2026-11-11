"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ccc } from "@ckb-ccc/connector-react";

type CkbWalletState = {
  open: () => unknown;
  wallet?: ccc.Wallet;
  signer?: ccc.Signer;
  address?: string;
  balance?: bigint;
  error?: string;
  refresh: () => Promise<void>;
  isTestnet: boolean;
};

const CkbWalletContext = createContext<CkbWalletState | null>(null);

/**
 * The CKB L1 wallet (CCC: JoyID and others) of the Fiber node's funding page (/app/fiber/fund), the one place on the
 * site where an L1 wallet signs: it funds the node. One state for the whole form, so its balance never disagrees.
 */
export function CkbWalletProvider({ children }: { children: ReactNode }) {
  const { open, wallet, signerInfo, client } = ccc.useCcc();
  const signer = signerInfo?.signer;
  const [address, setAddress] = useState<string>();
  const [balance, setBalance] = useState<bigint>();
  const [error, setError] = useState<string>();
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    // Only the latest read may update the form, so a quick wallet switch never shows the old account.
    const id = ++requestId.current;
    if (!signer) {
      setAddress(undefined);
      setBalance(undefined);
      setError(undefined);
      return;
    }
    try {
      const [addr, bal] = await Promise.all([signer.getRecommendedAddress(), signer.getBalance()]);
      if (id !== requestId.current) return;
      setAddress(addr);
      setBalance(bal);
      setError(undefined);
    } catch (e) {
      if (id === requestId.current) setError(e instanceof Error ? e.message : "Could not read the wallet.");
    }
  }, [signer]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo<CkbWalletState>(
    () => ({
      open,
      wallet,
      signer,
      address,
      balance,
      error,
      refresh,
      isTestnet: client.addressPrefix === "ckt",
    }),
    [open, wallet, signer, address, balance, error, refresh, client],
  );

  return <CkbWalletContext.Provider value={value}>{children}</CkbWalletContext.Provider>;
}

export function useCkbWallet(): CkbWalletState {
  const ctx = useContext(CkbWalletContext);
  if (!ctx) throw new Error("useCkbWallet must be used inside CkbWalletProvider.");
  return ctx;
}
