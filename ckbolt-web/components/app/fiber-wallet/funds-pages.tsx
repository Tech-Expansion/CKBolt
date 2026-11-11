"use client";

import { tokenFaucets } from "@/lib/faucets";
import type { WalletPage } from "@/lib/wallets/fiber-popup/constants";
import { NodeAddress } from "../fiber-node/node-address";
import { textButton } from "../fiber-node/styles";
import type { NodeWorkspace } from "../fiber-node/use-node-workspace";
import { WithdrawSection } from "../fiber-node/withdraw-section";
import { ADD_FUNDS_COPY, WITHDRAW_PAGE_COPY } from "./copy";

/** Add funds: the node's CKB address with its QR code, and the funding page, where the visitor's CKB wallet signs. */
export function AddFundsPage({ ws }: { ws: NodeWorkspace }) {
  if (!ws.address) return null;
  return (
    <div className="space-y-4" data-testid="fiber-wallet-add-funds">
      <NodeAddress
        address={ws.address}
        onRefreshBalance={() => void ws.data.refreshBalance()}
        fundLabel={ADD_FUNDS_COPY.FUND}
        qr
        faucets={tokenFaucets(ws.tokens)}
      />
    </div>
  );
}

/** Withdraw: the node's on-chain CKB to the visitor's address; a channel's funds come back to the node when it closes. */
export function WithdrawPage({ ws, onOpen }: { ws: NodeWorkspace; onOpen: (page: WalletPage) => void }) {
  if (!ws.fundingLock) return null;
  return (
    <div className="space-y-4" data-testid="fiber-wallet-withdraw">
      <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
        {WITHDRAW_PAGE_COPY.CHANNELS_NOTE}
        <button type="button" onClick={() => onOpen("channels")} className={textButton} data-testid="fiber-wallet-withdraw-channels">
          {WITHDRAW_PAGE_COPY.CHANNELS}
        </button>
      </p>
      <WithdrawSection
        startOpen
        record={ws.nodeKey.record}
        rpcUrl={ws.config.ckbRpcUrl}
        network={ws.config.network}
        node={ws.node}
        nodeLock={ws.fundingLock}
        balance={ws.data.balance}
        channels={ws.data.channels}
        onSent={() => void ws.data.refreshBalance()}
        onRecord={ws.activity.record}
        tokens={ws.withdrawTokens}
        readTokenBalance={ws.readTokenBalance}
      />
    </div>
  );
}
