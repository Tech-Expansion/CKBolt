import { UUID_PATTERN } from "@/lib/hub/constants";
import type { NodePhase } from "@/lib/wallets/fiber-browser/bridge-protocol";
import type { EntryRef } from "@/lib/wallets/fiber-browser/history";
import { WALLET_PAGES, WALLET_RELAY, WALLET_RELAY_TIMING, type WalletPage } from "./constants";

/**
 * Messages between the page (the header button and its popover) and the wallet's iframe. Both sides are the same origin,
 * and each checks it: the page takes messages only from its own iframe's window and origin, the iframe only from its
 * parent's. The status carries what the header button shows and nothing more; builders and parsers copy only the fields
 * listed here, so a key, password or invoice can never ride along.
 */

/** What the wallet tells the page about itself. Amounts are decimal strings of base units. */
export interface WalletRelayStatus {
  /** The iframe can run the node (cross-origin isolated); false: it offers the wallet in a window instead. */
  isolated: boolean;
  /** The node's phase, or null when no node answers (the window is not open yet). */
  phase: NodePhase | null;
  /** A node key is stored in this browser. */
  hasKey: boolean;
  /** CKB the node can send over ready channels; null unless it runs. */
  sendCkb: string | null;
}

export type FocusEdge = "first" | "last";

type Envelope = { source: typeof WALLET_RELAY.SOURCE; v: typeof WALLET_RELAY.VERSION };

export type RelayMessage =
  | (Envelope & { kind: typeof WALLET_RELAY.KIND.STATUS; status: WalletRelayStatus })
  | (Envelope & { kind: typeof WALLET_RELAY.KIND.CLOSE })
  | (Envelope & { kind: typeof WALLET_RELAY.KIND.FOCUS; edge: FocusEdge })
  | (Envelope & { kind: typeof WALLET_RELAY.KIND.VISIBILITY; open: boolean })
  | (Envelope & { kind: typeof WALLET_RELAY.KIND.NAVIGATE; page: WalletPage })
  | (Envelope & { kind: typeof WALLET_RELAY.KIND.OPEN_ENTRY; entry: EntryRef });

const ENVELOPE: Envelope = { source: WALLET_RELAY.SOURCE, v: WALLET_RELAY.VERSION };
const PHASES: readonly string[] = ["locked", "starting", "running", "other-tab", "failed"] satisfies NodePhase[];
const EDGES: readonly string[] = ["first", "last"] satisfies FocusEdge[];
const BASE_UNITS = /^\d{1,30}$/;
const PAGES: readonly string[] = WALLET_PAGES;
/** A payment hash (or, for an on-chain send, its transaction hash): 0x and 32 bytes of hex. */
const HASH = /^0x[0-9a-f]{64}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The status with exactly the listed fields, each checked; null when one is not what it should be. */
export function pickStatus(value: unknown): WalletRelayStatus | null {
  if (!isRecord(value)) return null;
  const { isolated, phase, hasKey, sendCkb } = value;
  if (typeof isolated !== "boolean" || typeof hasKey !== "boolean") return null;
  if (phase !== null && (typeof phase !== "string" || !PHASES.includes(phase))) return null;
  if (sendCkb !== null && (typeof sendCkb !== "string" || !BASE_UNITS.test(sendCkb))) return null;
  return { isolated, phase: phase as NodePhase | null, hasKey, sendCkb };
}

export function statusMessage(status: WalletRelayStatus): RelayMessage {
  const picked = pickStatus(status);
  if (!picked) throw new Error("The wallet's status is malformed.");
  return { ...ENVELOPE, kind: WALLET_RELAY.KIND.STATUS, status: picked };
}

export const closeMessage = (): RelayMessage => ({ ...ENVELOPE, kind: WALLET_RELAY.KIND.CLOSE });

export const focusMessage = (edge: FocusEdge): RelayMessage => ({ ...ENVELOPE, kind: WALLET_RELAY.KIND.FOCUS, edge });

export const visibilityMessage = (open: boolean): RelayMessage => ({ ...ENVELOPE, kind: WALLET_RELAY.KIND.VISIBILITY, open });

export const navigateMessage = (page: WalletPage): RelayMessage => ({ ...ENVELOPE, kind: WALLET_RELAY.KIND.NAVIGATE, page });

/**
 * The History reference with exactly its two fields: a swap's id (a UUID) and a 0x hash, each or null; null when
 * neither is. Ids and hashes only: never an invoice, a preimage or a key.
 */
export function pickEntryRef(value: unknown): EntryRef | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" && UUID_PATTERN.test(value.id) ? value.id : null;
  const hash = typeof value.hash === "string" && HASH.test(value.hash.toLowerCase()) ? value.hash.toLowerCase() : null;
  return id || hash ? { id, hash } : null;
}

export function openEntryMessage(entry: EntryRef): RelayMessage {
  const picked = pickEntryRef(entry);
  if (!picked) throw new Error("The History reference is malformed.");
  return { ...ENVELOPE, kind: WALLET_RELAY.KIND.OPEN_ENTRY, entry: picked };
}

/** A relay message of this version, rebuilt from its listed fields only; null for anything else. */
export function parseRelayMessage(data: unknown): RelayMessage | null {
  if (!isRecord(data) || data.source !== WALLET_RELAY.SOURCE || data.v !== WALLET_RELAY.VERSION) return null;
  switch (data.kind) {
    case WALLET_RELAY.KIND.STATUS: {
      const status = pickStatus(data.status);
      return status ? { ...ENVELOPE, kind: WALLET_RELAY.KIND.STATUS, status } : null;
    }
    case WALLET_RELAY.KIND.CLOSE:
      return closeMessage();
    case WALLET_RELAY.KIND.FOCUS:
      return typeof data.edge === "string" && EDGES.includes(data.edge) ? focusMessage(data.edge as FocusEdge) : null;
    case WALLET_RELAY.KIND.VISIBILITY:
      return typeof data.open === "boolean" ? visibilityMessage(data.open) : null;
    case WALLET_RELAY.KIND.NAVIGATE:
      return typeof data.page === "string" && PAGES.includes(data.page) ? navigateMessage(data.page as WalletPage) : null;
    case WALLET_RELAY.KIND.OPEN_ENTRY: {
      const entry = pickEntryRef(data.entry);
      return entry ? openEntryMessage(entry) : null;
    }
    default:
      return null;
  }
}

/** The part of a MessageEvent the checks read. */
export interface RelayEvent {
  origin: string;
  source: unknown;
}

/** The page side: the message came from its own wallet iframe (`frame`, its contentWindow) on the page's origin. */
export const isFromWalletFrame = (event: RelayEvent, expected: { origin: string; frame: unknown }): boolean =>
  event.origin === expected.origin && expected.frame !== null && expected.frame !== undefined && event.source === expected.frame;

/**
 * How the wallet answers the page: not opened yet, loading (no status yet), live, stale (it stopped posting), or
 * unanswered (no status at all within the load timeout).
 */
export type RelayHealth = "idle" | "loading" | "live" | "stale" | "unanswered";

export function relayHealth(times: { mountedAt: number | null; statusAt: number | null; nowMs: number }): RelayHealth {
  const { mountedAt, statusAt, nowMs } = times;
  if (mountedAt === null) return "idle";
  if (statusAt === null) return nowMs - mountedAt > WALLET_RELAY_TIMING.LOAD_TIMEOUT_MS ? "unanswered" : "loading";
  return nowMs - statusAt > WALLET_RELAY_TIMING.STALE_MS ? "stale" : "live";
}

/**
 * A wallet that does not answer may be reloaded from the popover, but never one whose node was last seen running: a
 * reload would stop the node in the middle of whatever it does.
 */
export const offersReload = (status: WalletRelayStatus | null, health: RelayHealth): boolean =>
  (health === "unanswered" || health === "stale") && status?.phase !== "running";

/** The iframe side: the message came from the page that embeds it (`parent`), on the same origin. */
export const isFromParentPage = (event: RelayEvent, expected: { origin: string; parent: unknown; self: unknown }): boolean =>
  event.origin === expected.origin && expected.parent !== expected.self && event.source === expected.parent;
