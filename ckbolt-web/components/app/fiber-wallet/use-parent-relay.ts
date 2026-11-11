"use client";

import { useEffect, useRef } from "react";
import { WALLET_RELAY, WALLET_RELAY_TIMING, type WalletPage } from "@/lib/wallets/fiber-popup/constants";
import type { EntryRef } from "@/lib/wallets/fiber-browser/history";
import {
  closeMessage,
  isFromParentPage,
  parseRelayMessage,
  statusMessage,
  type FocusEdge,
  type WalletRelayStatus,
} from "@/lib/wallets/fiber-popup/relay";

/** True inside the header's popover (an iframe of this site); false in a window or tab of its own. */
export const isFramed = (): boolean => typeof window !== "undefined" && window.parent !== window;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]';

/** Focuses the wallet's first or last control that Tab reaches: shown, and not taken out of the tab order. */
function focusEdge(edge: FocusEdge): void {
  const tabbable = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
  (edge === "first" ? tabbable[0] : tabbable.at(-1))?.focus();
}

/**
 * The wallet's side of the popover: it tells the page its status (what the header button shows, nothing secret) when
 * it changes and every few seconds, so the page notices a wallet that stopped answering; it asks the page to close when
 * Escape is pressed inside it and nothing here took the key; it moves focus to its first or last control when the
 * page's focus trap asks; it calls `onHidden` when the popover hides, `onNavigate` when the page asks for one of the
 * wallet's pages, and `onOpenEntry` when it asks for an entry of History (a swap id or a hash, nothing else). Messages go
 * to the parent on this origin only, and are taken from it only. Outside a frame it does nothing.
 */
export function useParentRelay(
  status: WalletRelayStatus | null,
  handlers: { onHidden?: () => void; onNavigate?: (page: WalletPage) => void; onOpenEntry?: (entry: EntryRef) => void } = {},
): void {
  const framed = isFramed();
  const key = status ? JSON.stringify(statusMessage(status)) : null;
  const latest = useRef({ status, ...handlers });
  useEffect(() => {
    latest.current = { status, ...handlers };
  });

  useEffect(() => {
    if (!framed || !key) return;
    const post = () => {
      if (latest.current.status) window.parent.postMessage(statusMessage(latest.current.status), location.origin);
    };
    post();
    const id = setInterval(post, WALLET_RELAY_TIMING.REPOST_MS);
    return () => clearInterval(id);
  }, [framed, key]);

  useEffect(() => {
    if (!framed) return;
    const onMessage = (event: MessageEvent) => {
      if (!isFromParentPage(event, { origin: location.origin, parent: window.parent, self: window })) return;
      const message = parseRelayMessage(event.data);
      if (message?.kind === WALLET_RELAY.KIND.FOCUS) focusEdge(message.edge);
      else if (message?.kind === WALLET_RELAY.KIND.VISIBILITY && !message.open) latest.current.onHidden?.();
      else if (message?.kind === WALLET_RELAY.KIND.NAVIGATE) latest.current.onNavigate?.(message.page);
      else if (message?.kind === WALLET_RELAY.KIND.OPEN_ENTRY) latest.current.onOpenEntry?.(message.entry);
    };
    // Radix popovers inside take Escape first and mark it handled; anything else closes the wallet.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) window.parent.postMessage(closeMessage(), location.origin);
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [framed]);
}
