"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useSharedHubStatus } from "@/hooks/use-hub-status";
import type { FiberWalletApi } from "../contracts";
import { FiberWalletDialog } from "./fiber-dialog";
import { useFiberWalletController } from "./use-fiber-wallet-controller";

/** Opens the Fiber node's dialog: the node's chip uses it, and so can the swap card's primary button. */
export interface WalletDialogs {
  /** The dialog is open now. */
  open: boolean;
  openWalletDialog: () => void;
}

const FiberWalletContext = createContext<FiberWalletApi | null>(null);
const WalletDialogsContext = createContext<WalletDialogs | null>(null);

/**
 * The swap card's one wallet: the visitor's Fiber node (`useFiberWallet()`) and its dialog, rendered once here and
 * opened with `useWalletDialogs().openWalletDialog()`. The Lightning side needs no wallet here: the visitor pays or
 * gets paid by QR code or pasted invoice. Needs the page's HubStatusProvider above it, for the hub's network and assets.
 */
export function FiberWalletProvider({ children }: { children: ReactNode }) {
  const hub = useSharedHubStatus();
  const [open, setOpen] = useState(false);
  const fiber = useFiberWalletController(hub.health?.fiber.network ?? null, open);

  const openWalletDialog = useCallback(() => setOpen(true), []);
  const dialogs = useMemo(() => ({ open, openWalletDialog }), [open, openWalletDialog]);

  return (
    <FiberWalletContext.Provider value={fiber.api}>
      <WalletDialogsContext.Provider value={dialogs}>
        {children}
        <FiberWalletDialog open={open} onOpenChange={setOpen} wallet={fiber.api} node={fiber.node} assets={hub.assets} />
      </WalletDialogsContext.Provider>
    </FiberWalletContext.Provider>
  );
}

/** The visitor's Fiber wallet, from the nearest FiberWalletProvider. */
export function useFiberWallet(): FiberWalletApi {
  const wallet = useContext(FiberWalletContext);
  if (!wallet) throw new Error("useFiberWallet needs a FiberWalletProvider above it.");
  return wallet;
}

/** The Fiber node's dialog, from the nearest FiberWalletProvider. */
export function useWalletDialogs(): WalletDialogs {
  const dialogs = useContext(WalletDialogsContext);
  if (!dialogs) throw new Error("useWalletDialogs needs a FiberWalletProvider above it.");
  return dialogs;
}
