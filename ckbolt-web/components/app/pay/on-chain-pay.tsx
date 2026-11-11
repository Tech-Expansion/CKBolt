"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { localeDecimalMark } from "@/lib/amount";
import { formatUnits } from "@/lib/hub/format";
import { PAY_COPY, PAY_ERROR } from "@/lib/pay/copy";
import type { ShortError } from "@/lib/swap/errors";
import { BridgeError } from "@/lib/wallets/fiber-browser/bridge-client";
import { BRIDGE_ERROR, type OnChainSendResult } from "@/lib/wallets/fiber-browser/bridge-protocol";
import { parseTokenAmount } from "@/lib/wallets/fiber-browser/tokens";
import { CKB_DECIMALS } from "@/lib/wallets/fiber-browser/constants";
import { explorerTxUrl } from "@/lib/wallets/fiber-byo/funding";
import { readNodeFunds } from "@/lib/wallets/fiber-wallet/node-page";
import { ViewInHistory } from "../fiber-wallet/host/view-in-history";
import { useWalletHost } from "../fiber-wallet/host/wallet-host";
import { StatusNotice } from "../status";
import { CopyButton, Row, shorten } from "../ui";
import { ConfirmInNode, NewPaymentButton, NodeNeeded, nodeRunning, PayButton, PayError, showConfirm, type PayFlowProps } from "./pay-parts";

const ckb = (shannons: string | bigint): string => `${formatUnits(shannons.toString(), CKB_DECIMALS)} CKB`;

/** A bridge refusal in one line; a node that did not answer may have sent it, so History is where to look. */
const bridgeError = (e: unknown): ShortError =>
  e instanceof BridgeError && e.code === BRIDGE_ERROR.TIMEOUT
    ? { line: PAY_ERROR.NODE_DID_NOT_ANSWER, detail: e.message }
    : { line: e instanceof Error && e.message ? e.message : PAY_ERROR.NODE_DID_NOT_ANSWER, detail: null };

/**
 * Send CKB on chain to an address (docs/pay-get-paid.md, part B), from the browser node's on-chain balance. The node's
 * key opens only with its password, which is typed in the node, never here: Send asks the node, which checks the address
 * and amount, prices the transaction and puts it up for the visitor's Confirm with the password; it signs, sends exactly
 * the amount with the change back to itself, and answers with the transaction.
 */
export function OnChainPay({ address, presence, client, onLock, onDone }: PayFlowProps & { address: string }) {
  const host = useWalletHost();
  const running = nodeRunning(presence);
  const amountId = useId();
  const errorId = useId();
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<ShortError | null>(null);
  const [sent, setSent] = useState<OnChainSendResult | null>(null);
  const decimalMark = useMemo(() => localeDecimalMark(), []);

  const locked = asking || sent !== null;
  useEffect(() => {
    onLock(locked);
  }, [locked, onLock]);

  const amount = text.trim() ? parseTokenAmount(text, CKB_DECIMALS, decimalMark) : null;
  const balance = readNodeFunds(presence ?? null)?.onChainCkb ?? null;
  const amountError: ShortError | null = !text.trim()
    ? null
    : amount === null
      ? { line: PAY_ERROR.AMOUNT, detail: null }
      : balance !== null && amount >= balance
        ? { line: PAY_ERROR.OVER_BALANCE(formatUnits(balance.toString(), CKB_DECIMALS)), detail: null }
        : null;

  const send = async () => {
    if (amount === null || amountError || asking) return;
    setAsking(true);
    setAskError(null);
    // The node shows the request on its Confirm page, with its password field; the popover opens there.
    showConfirm(host);
    try {
      setSent(await client.requestOnChainSend({ address, amount: amount.toString() }));
    } catch (e) {
      setAskError(bridgeError(e));
    } finally {
      setAsking(false);
    }
  };

  if (sent) {
    return (
      <section aria-label={PAY_COPY.RESULT_LABEL} className="space-y-3" data-testid="pay-result" data-status="sent">
        <StatusNotice tone="ok" role="status">
          <p className="font-medium">{PAY_COPY.SENT_ON_CHAIN(ckb(sent.amount))}</p>
          <p className="mt-1 text-sm">{PAY_COPY.SENT_ON_CHAIN_LINE}</p>
        </StatusNotice>
        <dl>
          <Row label={PAY_COPY.TO} value={shorten(address, 12)} />
          <Row label={PAY_COPY.NETWORK_FEE} value={ckb(sent.fee)} />
          <Row label={PAY_COPY.TRANSACTION} value={shorten(sent.txHash, 10)} />
        </dl>
        <div className="flex flex-wrap items-center gap-x-5">
          <CopyButton value={sent.txHash} label={PAY_COPY.COPY_TX} />
          <a
            href={explorerTxUrl(sent.txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-10 items-center text-sm underline underline-offset-4"
            data-testid="pay-explorer"
          >
            {PAY_COPY.EXPLORER}
          </a>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <ViewInHistory entry={{ id: null, hash: sent.txHash }} className="mr-auto" />
          <NewPaymentButton onPress={onDone} />
        </div>
      </section>
    );
  }

  const error = askError ?? amountError;
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={amountId} className="font-mono text-xs text-foreground/70">
            {PAY_COPY.AMOUNT_LABEL}
          </label>
          {balance !== null && <span className="font-mono text-xs text-foreground/70">{PAY_COPY.ON_CHAIN(formatUnits(balance.toString(), CKB_DECIMALS))}</span>}
        </div>
        <input
          id={amountId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          onChange={(e) => setText(e.target.value)}
          readOnly={asking}
          placeholder={PAY_COPY.AMOUNT_PLACEHOLDER}
          aria-invalid={amountError !== null}
          aria-describedby={error ? errorId : undefined}
          className="h-14 w-full border border-foreground/15 bg-background px-3 font-display text-3xl tabular-nums focus:border-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
          data-testid="pay-amount"
        />
      </div>
      <dl className="border-y border-foreground/10" data-testid="pay-preview" data-kind="ckb-address">
        <Row label={PAY_COPY.TO} value={shorten(address, 12)} />
        <Row label={PAY_COPY.AMOUNT} value={amount !== null ? ckb(amount) : "—"} />
      </dl>
      {!running && <NodeNeeded />}
      {asking && <ConfirmInNode password />}
      <PayButton
        label={amount !== null ? PAY_COPY.CONFIRM_SEND(ckb(amount)) : PAY_COPY.CONFIRM_SEND("CKB")}
        disabled={!running || amount === null || amountError !== null || asking}
        onPress={() => void send()}
      />
      <div id={errorId}>
        <PayError error={error} />
      </div>
    </div>
  );
}
