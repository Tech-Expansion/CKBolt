"use client";

import { useEffect, useState } from "react";
import type { AssetDto } from "@/lib/hub/contract";
import { PAY_TIMING } from "@/lib/pay/constants";
import { PAY_COPY, PAY_ERROR } from "@/lib/pay/copy";
import type { ShortError } from "@/lib/swap/errors";
import { BridgeError } from "@/lib/wallets/fiber-browser/bridge-client";
import { BRIDGE_ERROR, type FiberInvoicePreview } from "@/lib/wallets/fiber-browser/bridge-protocol";
import { CKB_DECIMALS, PAYMENT_STATUS } from "@/lib/wallets/fiber-browser/constants";
import { assetDecimals, formatAssetUnits } from "@/lib/wallets/fiber-browser/tokens";
import { ViewInHistory } from "../fiber-wallet/host/view-in-history";
import { useWalletHost } from "../fiber-wallet/host/wallet-host";
import { usePolling } from "../fiber-node/use-polling";
import { StatusNotice } from "../status";
import { InfoTip } from "../swap/info-tip";
import { CopyButton, Row, shorten } from "../ui";
import { ConfirmInNode, NewPaymentButton, NodeNeeded, nodeRunning, PayButton, PayError, showConfirm, type PayFlowProps } from "./pay-parts";

type Read = { status: "reading" } | { status: "read"; preview: FiberInvoicePreview } | { status: "refused"; error: ShortError };

interface Sent {
  paymentHash: string;
  status: string;
  /** The routing fee it took, once paid. */
  fee: string | null;
  failedError: string | null;
  /** The node's get_payment answered at least once (send_payment's own answer carries no fee or reason). */
  read: boolean;
}

const final = (status: string): boolean => status === PAYMENT_STATUS.SUCCESS || status === PAYMENT_STATUS.FAILED;

/**
 * A bridge refusal in one line; a node that did not answer may still have the request, so History is where to look. No
 * route: Pay's own line, fnn's reason behind the "?".
 */
const bridgeError = (e: unknown): ShortError =>
  e instanceof BridgeError && e.code === BRIDGE_ERROR.TIMEOUT
    ? { line: PAY_ERROR.NODE_DID_NOT_ANSWER, detail: e.message }
    : e instanceof BridgeError && e.code === BRIDGE_ERROR.NO_ROUTE
      ? { line: PAY_ERROR.NO_ROUTE, detail: e.message || null }
      : { line: e instanceof Error && e.message ? e.message : PAY_ERROR.NODE_DID_NOT_ANSWER, detail: null };

const when = (ms: number): string => new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

/**
 * Pay a Fiber invoice (docs/pay-get-paid.md, part B): the page checked its network; the node reads and checks it
 * (parse_invoice), finds a route with dry runs (its own, or through the hub), and the preview shows its amount, payee,
 * route, max fee and expiry, checked against this page's clock. Pay
 * asks the node, which puts it up for the visitor's Confirm in the node, keeps its hash in History, then sends; the page
 * reads its status until paid or failed and shows the fee it took next to the max.
 */
export function FiberPay({ invoice, assets, presence, client, nowMs, onLock, onDone }: PayFlowProps & { invoice: string; assets: readonly AssetDto[] }) {
  const host = useWalletHost();
  const running = nodeRunning(presence);
  const [read, setRead] = useState<{ invoice: string; read: Read } | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<ShortError | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);

  // The node reads the invoice a moment after the last keystroke, once it runs.
  useEffect(() => {
    if (!running) return;
    let current = true;
    const timer = setTimeout(() => {
      setRead({ invoice, read: { status: "reading" } });
      client.readInvoice({ invoice }).then(
        (preview) => current && setRead({ invoice, read: { status: "read", preview } }),
        (e) => current && setRead({ invoice, read: { status: "refused", error: bridgeError(e) } }),
      );
    }, PAY_TIMING.readDelayMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [invoice, running, client]);

  const locked = asking || sent !== null;
  useEffect(() => {
    onLock(locked);
  }, [locked, onLock]);

  usePolling(
    async () => {
      if (!sent) return;
      try {
        const status = await client.paymentStatus({ paymentHash: sent.paymentHash });
        setSent((s) =>
          s && s.paymentHash === status.paymentHash
            ? { ...s, status: status.status, fee: status.status === PAYMENT_STATUS.SUCCESS ? status.fee : null, failedError: status.failedError, read: true }
            : s,
        );
      } catch {
        // The node may be busy: the next read may answer.
      }
    },
    PAY_TIMING.statusPollMs,
    // Until paid or failed, and once more if send_payment already said so, for the fee or the reason.
    sent !== null && (!final(sent.status) || !sent.read),
  );

  const state = read?.invoice === invoice ? read.read : { status: "reading" as const };
  const preview = state.status === "read" ? state.preview : null;
  const asset = preview ? assets.find((a) => a.id === preview.asset) : undefined;
  // The hub's decimals for the token (the node pays only tokens its hub lists); unknown ones show as base units.
  const decimals = preview ? assetDecimals(preview.asset, assets) : CKB_DECIMALS;
  const symbol = asset?.symbol ?? preview?.asset ?? "";
  const amountText = (units: string) => formatAssetUnits(units, decimals, symbol);
  // The page checks the expiry against its own clock before it asks (the node checks again at Confirm).
  const expired = preview?.expiresAt !== null && preview?.expiresAt !== undefined && preview.expiresAt <= nowMs;

  const pay = async () => {
    if (!preview || expired || asking) return;
    setAsking(true);
    setAskError(null);
    // The node shows the request on its Confirm page; the popover opens there (a node window shows it by itself).
    showConfirm(host);
    try {
      const result = await client.requestPayment({ invoice });
      setSent({ paymentHash: result.paymentHash, status: result.status, fee: null, failedError: null, read: false });
    } catch (e) {
      setAskError(bridgeError(e));
    } finally {
      setAsking(false);
    }
  };

  if (sent && preview) {
    const done = final(sent.status);
    const paid = sent.status === PAYMENT_STATUS.SUCCESS;
    return (
      <section aria-label={PAY_COPY.RESULT_LABEL} className="space-y-3" data-testid="pay-result" data-status={sent.status}>
        <StatusNotice tone={paid ? "ok" : done ? "error" : "pending"} role="status">
          <p className="font-medium">{paid ? PAY_COPY.PAID : done ? PAY_COPY.FAILED : PAY_COPY.SENDING}</p>
          {sent.failedError && <p className="mt-1 font-mono text-xs">{sent.failedError}</p>}
        </StatusNotice>
        <dl>
          <Row label={PAY_COPY.AMOUNT} value={amountText(preview.amount)} />
          <Row
            label={paid && sent.fee !== null ? PAY_COPY.ACTUAL_FEE : PAY_COPY.MAX_FEE}
            value={paid && sent.fee !== null ? PAY_COPY.FEE_OF_MAX(amountText(sent.fee), amountText(preview.maxFee)) : amountText(preview.maxFee)}
          />
          <Row label={PAY_COPY.PAYMENT_HASH} value={shorten(sent.paymentHash, 10)} />
        </dl>
        <CopyButton value={sent.paymentHash} label={PAY_COPY.COPY_HASH} />
        {done && (
          <div className="flex flex-wrap items-center justify-end gap-3">
            <ViewInHistory entry={{ id: null, hash: sent.paymentHash }} className="mr-auto" />
            <NewPaymentButton onPress={onDone} />
          </div>
        )}
      </section>
    );
  }

  const error: ShortError | null = askError ?? (state.status === "refused" ? state.error : expired ? { line: PAY_ERROR.EXPIRED, detail: null } : null);
  return (
    <div className="space-y-4">
      {!running ? (
        <NodeNeeded />
      ) : state.status === "reading" ? (
        <p className="text-sm text-muted-foreground" role="status">
          {PAY_COPY.READING}
        </p>
      ) : (
        preview && (
          <dl className="border-y border-foreground/10" data-testid="pay-preview" data-kind="fiber">
            <Row label={PAY_COPY.AMOUNT} value={amountText(preview.amount)} />
            <Row label={PAY_COPY.TO} value={preview.payee ? shorten(preview.payee, 8) : PAY_COPY.UNKNOWN_PAYEE} />
            <div className="flex items-center justify-between gap-3 border-b border-foreground/5 py-3" data-testid="pay-route" data-route={preview.route}>
              <dt className="flex items-center gap-1 text-sm text-muted-foreground">
                {PAY_COPY.ROUTE}
                <InfoTip label={PAY_COPY.ROUTE_TIP_LABEL} align="start">
                  {PAY_COPY.ROUTE_TIP}
                </InfoTip>
              </dt>
              <dd className="min-w-0 text-right font-mono text-sm [overflow-wrap:anywhere]">{PAY_COPY.ROUTE_KIND[preview.route]}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-foreground/5 py-3">
              <dt className="flex items-center gap-1 text-sm text-muted-foreground">
                {PAY_COPY.MAX_FEE}
                <InfoTip label={PAY_COPY.MAX_FEE_TIP_LABEL} align="start">
                  {PAY_COPY.MAX_FEE_TIP}
                </InfoTip>
              </dt>
              <dd className="font-mono text-sm tabular-nums">{amountText(preview.maxFee)}</dd>
            </div>
            {preview.expiresAt !== null && <Row label={PAY_COPY.EXPIRES} value={when(preview.expiresAt)} />}
          </dl>
        )
      )}
      {asking && <ConfirmInNode />}
      <PayButton label={preview ? PAY_COPY.CONFIRM_PAY(amountText(preview.amount)) : PAY_COPY.TITLE} disabled={!preview || expired || asking || !running} onPress={() => void pay()} />
      <PayError error={error} />
    </div>
  );
}
