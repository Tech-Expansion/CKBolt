import { nodePhaseTone, type StatusTone } from "@/lib/status-tone";
import type { NodePhase } from "@/lib/wallets/fiber-browser/bridge-protocol";
import { CKB_DECIMALS } from "@/lib/wallets/fiber-browser/constants";
import { formatShortUnits } from "@/lib/wallets/fiber-browser/tokens";
import { WALLET_BUTTON_FRACTION_DIGITS } from "./constants";
import type { RelayHealth, WalletRelayStatus } from "./relay";

export interface WalletButtonView {
  /** The short label on the button. */
  label: string;
  /** The state's colour (lib/status-tone.ts): running green, starting or waiting amber, failed red, off grey. */
  tone: StatusTone;
  /** The state in words, for the button's accessible name and title. */
  state: string;
}

/** The header button's words (docs/fiber-wallet-popup.md, section 2). */
export const WALLET_BUTTON_COPY = {
  NAME: "Fiber node",
  /** The running node's label: the CKB it can send. */
  SENDABLE: (ckb: string) => `${ckb} CKB`,
  STATE: {
    NOT_OPENED: "not opened",
    LOADING: "loading",
    NOT_ANSWERING: "not answering",
    NEW: "no key yet",
    WINDOW: "opens in a window",
    RUNNING: (ckb: string) => `running, can send ${ckb} CKB`,
  },
  PHASE_LABEL: {
    locked: "Locked",
    starting: "Starting…",
    running: "Running",
    "other-tab": "Other tab",
    failed: "Failed",
  } satisfies Record<NodePhase, string>,
  PHASE_STATE: {
    locked: "locked",
    starting: "starting",
    running: "running",
    "other-tab": "runs in another tab",
    failed: "failed to start",
  } satisfies Record<NodePhase, string>,
  /** The popover's state badge, beside its title. */
  BADGE: {
    NEW: "No key yet",
    WINDOW: "In a window",
    NOT_ANSWERING: "Not answering",
  },
} as const;

/**
 * The header button from the node's last status: "Fiber node" until the wallet is opened (or while no key exists),
 * "Locked" while locked, and the CKB the node can send while it runs. A wallet that stopped answering keeps its last
 * label with the error colour, and says so in words.
 */
export function walletButtonView(status: WalletRelayStatus | null, health: RelayHealth): WalletButtonView {
  const { NAME, STATE } = WALLET_BUTTON_COPY;
  if (health === "idle") return { label: NAME, tone: "off", state: STATE.NOT_OPENED };
  if (!status) return health === "unanswered" ? { label: NAME, tone: "error", state: STATE.NOT_ANSWERING } : { label: NAME, tone: "pending", state: STATE.LOADING };
  const view = statusView(status);
  return health === "stale" ? { label: view.label, tone: "error", state: `${view.state}, ${STATE.NOT_ANSWERING}` } : view;
}

function statusView(status: WalletRelayStatus): WalletButtonView {
  const { NAME, STATE, PHASE_LABEL, PHASE_STATE } = WALLET_BUTTON_COPY;
  if (status.phase === "running") {
    const ckb = formatShortUnits(status.sendCkb ?? "0", CKB_DECIMALS, WALLET_BUTTON_FRACTION_DIGITS);
    return { label: WALLET_BUTTON_COPY.SENDABLE(ckb), tone: "ok", state: STATE.RUNNING(ckb) };
  }
  // Without isolation the iframe runs nothing: it reports the node of a wallet window, when one answers.
  if (!status.isolated && status.phase === null) return { label: NAME, tone: "off", state: STATE.WINDOW };
  if (isNew(status)) return { label: NAME, tone: "off", state: STATE.NEW };
  const phase = status.phase ?? "locked";
  return { label: PHASE_LABEL[phase], tone: nodePhaseTone(phase), state: PHASE_STATE[phase] };
}

const isNew = (status: WalletRelayStatus): boolean => status.isolated && !status.hasKey && (status.phase === null || status.phase === "locked");

/** The popover's state badge beside its title ("Running", "Locked"...), or null while the wallet has not reported yet. */
export function walletStateBadge(status: WalletRelayStatus | null, health: RelayHealth): { label: string; tone: StatusTone } | null {
  const { BADGE, PHASE_LABEL } = WALLET_BUTTON_COPY;
  if (health === "stale" || health === "unanswered") return { label: BADGE.NOT_ANSWERING, tone: "error" };
  if (!status) return null;
  if (status.phase === null) return { label: BADGE.WINDOW, tone: "off" };
  if (isNew(status)) return { label: BADGE.NEW, tone: "off" };
  return { label: PHASE_LABEL[status.phase], tone: nodePhaseTone(status.phase) };
}
