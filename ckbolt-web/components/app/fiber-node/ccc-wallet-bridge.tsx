"use client";

import { useEffect, useRef, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { cccNodeClient } from "@/lib/wallets/fiber-browser/ccc-withdraw";
import type { CkbAddressNetwork } from "@/lib/wallets/fiber-browser/ckb-address";
import { DESTINATION_COPY } from "./copy";
import type { WalletRequest, WalletStatus } from "./wallet-picker";

interface BridgeProps {
  rpcUrl: string;
  network: CkbAddressNetwork;
  request: WalletRequest | null;
  onDone: (id: number) => void;
  onStatus: (status: WalletStatus) => void;
  onReady: () => void;
}

/**
 * CCC's connector on the node page, loaded on demand by WalletPickerProvider. Its client talks to the node's own CKB RPC
 * only. It answers address requests: the connected wallet's address, or the connector opened first.
 */
export function CccWalletBridge({ rpcUrl, network, ...props }: BridgeProps) {
  const [client] = useState(() => cccNodeClient(rpcUrl, network));
  return (
    <ccc.Provider name="CKBolt" hideMark defaultClient={client}>
      <Bridge {...props} />
    </ccc.Provider>
  );
}

function Bridge({ request, onDone, onStatus, onReady }: Omit<BridgeProps, "rpcUrl" | "network">) {
  const { open, signerInfo, wallet } = ccc.useCcc();
  const signer = signerInfo?.signer;
  const walletName = signer ? wallet?.name || DESTINATION_COPY.WALLET_FALLBACK_NAME : null;
  const opened = useRef<number | null>(null);

  useEffect(() => onReady(), [onReady]);
  useEffect(() => onStatus({ walletName, error: null }), [walletName, onStatus]);

  useEffect(() => {
    if (!request) return;
    if (!signer) {
      // Once per request: the connector opens, and the address follows when a wallet connects.
      if (opened.current !== request.id) {
        opened.current = request.id;
        open();
      }
      return;
    }
    let current = true;
    signer.getRecommendedAddress().then(
      (address) => {
        if (!current) return;
        request.deliver(address);
        onDone(request.id);
      },
      () => {
        if (!current) return;
        onStatus({ walletName, error: DESTINATION_COPY.WALLET_UNREADABLE });
        onDone(request.id);
      },
    );
    return () => {
      current = false;
    };
  }, [request, signer, open, onDone, onStatus, walletName]);

  return null;
}
