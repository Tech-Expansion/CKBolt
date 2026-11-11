"use client";

import { useCallback, useRef, useState } from "react";
import { REQUEST_TIMING } from "@/lib/get-paid/constants";
import { REQUEST_ERROR } from "@/lib/get-paid/copy";
import type { FiberAsk, OpenRequest } from "@/lib/get-paid/request";
import { fiberStepError, type ShortError } from "@/lib/swap/errors";
import { BridgeError, type BridgeClient } from "@/lib/wallets/fiber-browser/bridge-client";
import { BRIDGE_ERROR } from "@/lib/wallets/fiber-browser/bridge-protocol";
import { BROWSER_NODE_NETWORK, INVOICE_FINAL_STATUSES } from "@/lib/wallets/fiber-browser/constants";
import { checkNodeInvoice } from "@/lib/wallets/fiber-wallet/invoice-check";
import { usePolling } from "../fiber-node/use-polling";

export interface FiberInvoice {
  ask: FiberAsk | null;
  /** A Fiber invoice for `request` from the node (again after one expired or was refused). */
  make: (request: OpenRequest) => void;
  /** Forgets it on this page; it stays in the node's History and payable until it expires. */
  reset: () => void;
}

/** The node did not answer: it may still have made the invoice (its History shows it), so the page says to try again. */
const makeError = (e: unknown): ShortError =>
  e instanceof BridgeError && e.code === BRIDGE_ERROR.TIMEOUT ? { line: REQUEST_ERROR.NODE_DID_NOT_ANSWER, detail: e.message } : fiberStepError(e);

/**
 * The Fiber invoice of a Get paid request (docs/pay-get-paid.md, part C): the browser node makes it over the bridge
 * (make-receive-invoice; it spends nothing, so the node asks for no Confirm), the page checks it is a Fiber invoice of
 * the node's network for exactly the amount, then reads its status through the node (invoice-status) until it is paid,
 * expired or cancelled.
 */
export function useFiberInvoice(client: BridgeClient): FiberInvoice {
  const [ask, setAsk] = useState<FiberAsk | null>(null);
  // Every make or reset starts a new round; an answer for an older one is dropped.
  const round = useRef(0);

  const make = useCallback(
    async (request: OpenRequest) => {
      const mine = ++round.current;
      setAsk({ status: "making" });
      try {
        const made = await client.makeReceiveInvoice({ asset: request.asset, amount: request.units, note: request.note, request: request.id });
        if (mine !== round.current) return;
        const check = checkNodeInvoice(made.invoice, { amount: request.units, network: BROWSER_NODE_NETWORK });
        setAsk(check.ok ? { status: "made", ...made, invoiceStatus: "Open" } : { status: "failed", error: { line: check.error, detail: null } });
      } catch (e) {
        if (mine === round.current) setAsk({ status: "failed", error: makeError(e) });
      }
    },
    [client],
  );

  const reset = useCallback(() => {
    round.current += 1;
    setAsk(null);
  }, []);

  const following = ask?.status === "made" && !INVOICE_FINAL_STATUSES.includes(ask.invoiceStatus) ? ask.paymentHash : null;
  usePolling(
    async () => {
      if (!following) return;
      try {
        const { paymentHash, status } = await client.invoiceStatus({ paymentHash: following });
        setAsk((a) => (a?.status === "made" && a.paymentHash === paymentHash && a.invoiceStatus !== status ? { ...a, invoiceStatus: status } : a));
      } catch {
        // The node may be busy: the next read may answer.
      }
    },
    REQUEST_TIMING.statusPollMs,
    following !== null,
  );

  return { ask, make: (request) => void make(request), reset };
}
