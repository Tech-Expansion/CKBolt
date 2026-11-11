"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { GripVertical, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EntryRef } from "@/lib/wallets/fiber-browser/history";
import { FIBER_WALLET_PATH, WALLET_RELAY, WALLET_RELAY_TIMING, type WalletPage } from "@/lib/wallets/fiber-popup/constants";
import {
  focusMessage,
  isFromWalletFrame,
  navigateMessage,
  offersReload,
  openEntryMessage,
  parseRelayMessage,
  relayHealth,
  visibilityMessage,
  type RelayHealth,
  type RelayMessage,
  type WalletRelayStatus,
} from "@/lib/wallets/fiber-popup/relay";
import { textButton } from "../../fiber-node/styles";
import { walletStateBadge } from "@/lib/wallets/fiber-popup/button-view";
import { StatusNotice } from "../../status";
import { WALLET_CHROME } from "../copy";
import { TestnetBadge, WalletStateBadge } from "../wallet-heading";
import { popover, popoverGrip, popoverHandle, popoverTitleBar } from "../styles";
import { usePopupDrag } from "./use-popup-drag";

/** The page's handle on the Fiber node popover. */
export interface WalletHost {
  /** The popover shows now. */
  open: boolean;
  /** The wallet's iframe exists: the visitor opened it once on this page load. */
  mounted: boolean;
  /** The wallet's last status (what the header button shows), or null before it reported one. */
  status: WalletRelayStatus | null;
  /** Whether the wallet answers: not opened, loading, live, stale or unanswered. */
  health: RelayHealth;
  /** Shows the popover, on one of its pages when `page` is given (the swap card's "Ask the hub for a channel" opens Channels). */
  show: (page?: WalletPage) => void;
  /** Shows the popover on History, open on one entry (the app's "View in History" after a swap, a payment or a request). */
  showEntry: (entry: EntryRef) => void;
  /** Hides the popover; the node keeps running. Focus returns to the header button unless `returnFocus` is false. */
  hide: (returnFocus?: boolean) => void;
  toggle: () => void;
  /** The header button, for focus return and so a click on it is not a click outside. */
  buttonRef: RefObject<HTMLButtonElement | null>;
}

/** The popover's id, for the header button's aria-controls. */
export const WALLET_POPOVER_ID = "fiber-wallet-popover";
const WALLET_TITLE_ID = "fiber-wallet-popover-title";

const WalletHostContext = createContext<WalletHost | null>(null);

/** The Fiber node popover, or null outside the root layout (the wallet's own document has no header button). */
export const useWalletHost = (): WalletHost | null => useContext(WalletHostContext);

/**
 * The header's popup runs the node: its pages (Confirm, History) are where the visitor goes. Elsewhere (the node's
 * window, the node page in another tab) the popover would only offer the window.
 */
export const popupRunsNode = (host: WalletHost | null): host is WalletHost => host?.status?.phase === "running";

/**
 * Hosts the Fiber node popup for every page (root layout). The wallet's iframe (/app/wallet) is created the first time the
 * visitor opens it and then only shown and hidden, never moved or unmounted, so the node keeps running across
 * client-side navigation; visitors who never open it load nothing. The page and the iframe talk by postMessage, each
 * checking the other's window and origin; only the status for the header button comes back, never a secret.
 */
export function FiberWalletHost({ children }: { children: ReactNode }) {
  const [mountedAt, setMountedAt] = useState<number | null>(null);
  const mounted = mountedAt !== null;
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<WalletRelayStatus | null>(null);
  const [statusAt, setStatusAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const gripRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // A page or an entry asked for before the wallet listens waits for its first status.
  const pending = useRef<RelayMessage[]>([]);
  const frameListens = useRef(false);
  const send = useCallback((message: RelayMessage) => {
    const frame = frameRef.current?.contentWindow;
    if (frame && frameListens.current) frame.postMessage(message, location.origin);
    else pending.current.push(message);
  }, []);
  const show = useCallback(
    (page?: WalletPage) => {
      setMountedAt((at) => at ?? Date.now());
      setOpen(true);
      if (page) send(navigateMessage(page));
    },
    [send],
  );
  const showEntry = useCallback(
    (entry: EntryRef) => {
      show();
      send(openEntryMessage(entry));
    },
    [show, send],
  );
  const hide = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);
  const latestOpen = useRef(open);
  useEffect(() => {
    latestOpen.current = open;
  });
  const toggle = useCallback(() => (latestOpen.current ? hide() : show()), [hide, show]);

  // The wallet's messages: its status, and Escape pressed inside it.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isFromWalletFrame(event, { origin: location.origin, frame: frameRef.current?.contentWindow })) return;
      const message = parseRelayMessage(event.data);
      if (message?.kind === WALLET_RELAY.KIND.STATUS) {
        setStatus(message.status);
        setStatusAt(Date.now());
        frameListens.current = true;
        for (const waiting of pending.current.splice(0)) send(waiting);
      } else if (message?.kind === WALLET_RELAY.KIND.CLOSE && latestOpen.current) hide();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [hide, send]);

  // While open: Escape closes it, and so does a click outside it and its button.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      hide();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (popoverRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
      hide(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    // After whatever closed before it (a dialog returning focus to its trigger), focus moves into the popover.
    const focus = setTimeout(() => closeRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      clearTimeout(focus);
    };
  }, [open, hide]);

  // The wallet re-posts its status every few seconds: watch its age, to tell a wallet that stopped answering.
  useEffect(() => {
    if (!mounted) return;
    const id = setInterval(() => setNowMs(Date.now()), WALLET_RELAY_TIMING.TICK_MS);
    return () => clearInterval(id);
  }, [mounted]);
  const health = relayHealth({ mountedAt, statusAt, nowMs });

  // From sm up the title bar moves the popup; it stays where the visitor leaves it (docs: "Moving the popup").
  const drag = usePopupDrag(popoverRef, open);

  // The wallet clears passwords typed in it when the popover hides.
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(visibilityMessage(open), location.origin);
  }, [open]);

  /** Loads the wallet again; offered only when its node was not last seen running (offersReload). */
  const reload = () => {
    if (!frameRef.current) return;
    setStatus(null);
    setStatusAt(null);
    frameListens.current = false;
    pending.current = [];
    setMountedAt(Date.now());
    setNowMs(Date.now());
    frameRef.current.src = FIBER_WALLET_PATH;
  };

  /**
   * The focus trap's ends: past the wallet's last control back to the popover's first (Move, or Close on a phone), and
   * before that one round to the wallet's last.
   */
  const focusWalletEnd = () => {
    const frame = frameRef.current?.contentWindow;
    if (!frame) return closeRef.current?.focus();
    frameRef.current?.focus();
    frame.postMessage(focusMessage("last"), location.origin);
  };

  const value = useMemo<WalletHost>(
    () => ({ open, mounted, status, health, show, showEntry, hide, toggle, buttonRef }),
    [open, mounted, status, health, show, showEntry, hide, toggle],
  );
  const silent = health === "stale" || health === "unanswered";

  return (
    <WalletHostContext.Provider value={value}>
      {children}
      {mounted && (
        <div
          ref={popoverRef}
          id={WALLET_POPOVER_ID}
          role="dialog"
          aria-modal="true"
          aria-labelledby={WALLET_TITLE_ID}
          hidden={!open}
          className={popover}
          data-dragging={drag.dragging || undefined}
          data-testid="fiber-wallet-popover"
        >
          <span tabIndex={0} onFocus={focusWalletEnd} data-focus-guard="start" />
          <div
            className={cn(popoverTitleBar, drag.movable && popoverHandle)}
            data-dragging={drag.dragging || undefined}
            data-testid="fiber-wallet-handle"
            {...(drag.movable ? drag.handleProps : {})}
          >
            {drag.movable && (
              // Its name says what it is; its title, the tooltip and its description, says how.
              <button
                ref={gripRef}
                type="button"
                onKeyDown={drag.onGripKeyDown}
                aria-label={WALLET_CHROME.MOVE}
                title={WALLET_CHROME.MOVE_HINT}
                className={popoverGrip}
                data-move-grip=""
                data-testid="fiber-wallet-move"
              >
                <GripVertical className="-ml-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              </button>
            )}
            <div className="flex min-w-0 items-center gap-2">
              <h2 id={WALLET_TITLE_ID} className="font-display text-2xl leading-none whitespace-nowrap">
                {WALLET_CHROME.TITLE}
              </h2>
              <WalletStateBadge state={walletStateBadge(status, health)} />
            </div>
            <div className="flex items-center gap-2">
              <TestnetBadge />
              <button
                ref={closeRef}
                type="button"
                onClick={() => hide()}
                aria-label={WALLET_CHROME.CLOSE}
                className="-mr-2 inline-flex h-10 w-10 cursor-default items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
                data-testid="fiber-wallet-close"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
          </div>
          {silent && (
            <StatusNotice tone="error" className="shrink-0 border-b border-b-foreground/10" role="status" data-testid="fiber-wallet-silent">
              <div className="flex flex-wrap items-center justify-between gap-x-3">
                <p>{WALLET_CHROME.NOT_ANSWERING}</p>
                {offersReload(status, health) && (
                  <button type="button" onClick={reload} className={textButton} data-testid="fiber-wallet-reload">
                    {WALLET_CHROME.RELOAD}
                  </button>
                )}
              </div>
            </StatusNotice>
          )}
          {/* Never moved in the page or re-rendered with another key: an iframe that moves reloads, and its node would
              restart (dragging the popup only transforms it). While a press on the title bar is under way the iframe
              takes no pointer events: it would swallow the moves. */}
          <iframe
            ref={frameRef}
            src={FIBER_WALLET_PATH}
            title={WALLET_CHROME.TITLE}
            className={cn("block min-h-0 w-full flex-1 border-0", drag.dragging && "pointer-events-none")}
            data-testid="fiber-wallet-frame"
          />
          <span tabIndex={0} onFocus={() => (gripRef.current ?? closeRef.current)?.focus()} data-focus-guard="end" />
        </div>
      )}
    </WalletHostContext.Provider>
  );
}
