"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { CkbAddressNetwork } from "@/lib/wallets/fiber-browser/ckb-address";

/** Hands a CKB wallet's address to the field that asked for it. */
export type DeliverAddress = (address: string) => void;

/** What the wallet connector reports back to the page. */
export interface WalletStatus {
  /** The connected wallet's name, or null while none is connected. */
  walletName: string | null;
  error: string | null;
}

/** One request for the connected wallet's address; a newer one replaces it. */
export interface WalletRequest {
  id: number;
  deliver: DeliverAddress;
}

export interface WalletPicker extends WalletStatus {
  /** The connector has loaded, so the button can act. */
  ready: boolean;
  /** Loads the connector (CCC) now, so a wallet connected earlier in this browser shows up. */
  load: () => void;
  /** Gives the connected wallet's address to `deliver`, opening the connector first when no wallet is connected. */
  pick: (deliver: DeliverAddress) => void;
}

const WalletPickerContext = createContext<WalletPicker | null>(null);

// CCC is heavy and the node page needs it only when the visitor gives an address, so it loads then.
const CccWalletBridge = dynamic(() => import("./ccc-wallet-bridge").then((m) => m.CccWalletBridge), { ssr: false });

/**
 * The visitor's CKB wallet on the node page, as a source of their address only: it never signs here. One CCC connector
 * for the whole page (several fields may ask), mounted beside the page once a field first shows. The isolated page
 * blocks popup wallets such as JoyID from connecting, but CCC restores one connected on the funding page.
 */
export function WalletPickerProvider({ rpcUrl, network, children }: { rpcUrl: string; network: CkbAddressNetwork; children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<WalletStatus>({ walletName: null, error: null });
  const [request, setRequest] = useState<WalletRequest | null>(null);
  const nextId = useRef(0);

  const load = useCallback(() => setLoaded(true), []);
  const pick = useCallback((deliver: DeliverAddress) => {
    setLoaded(true);
    setStatus((s) => ({ ...s, error: null }));
    setRequest({ id: ++nextId.current, deliver });
  }, []);
  const done = useCallback((id: number) => setRequest((r) => (r?.id === id ? null : r)), []);
  const onReady = useCallback(() => setReady(true), []);

  const value = useMemo<WalletPicker>(() => ({ ...status, ready, load, pick }), [status, ready, load, pick]);
  return (
    <WalletPickerContext.Provider value={value}>
      {children}
      {loaded && (
        <CccWalletBridge rpcUrl={rpcUrl} network={network} request={request} onDone={done} onStatus={setStatus} onReady={onReady} />
      )}
    </WalletPickerContext.Provider>
  );
}

export function useWalletPicker(): WalletPicker {
  const picker = useContext(WalletPickerContext);
  if (!picker) throw new Error("useWalletPicker needs a WalletPickerProvider above it.");
  return picker;
}
