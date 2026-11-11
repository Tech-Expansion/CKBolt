import { INVOICE_NOTE_MAX_LENGTH } from "@/lib/wallets/fiber-browser/constants";
import type { RequestPartStatus } from "./request";

/**
 * Every line Get paid shows on /app (docs/pay-get-paid.md, part C). Few words on screen, no sentence over 12 words; the
 * rest behind a "?" (docs/style-guide.md, Copy).
 */

export const REQUEST_COPY = {
  TITLE: "Get paid",
  NETWORK_TAG: "Testnet",

  /* the form */
  AMOUNT_LABEL: "Amount",
  TOKEN_SIDE: "You receive",
  CONVERSION: (usd: string, sats: string) => `${usd} · ${sats} sats on Lightning`,
  CONVERSION_TIP_LABEL: "About the conversion",
  CONVERSION_TIP:
    "What a Lightning payer would pay in sats, the hub's fee included, at the hub's prices now. You still receive the amount above. The Lightning invoice is made only when you open its tab, with a fresh quote.",
  NOTE_LABEL: "Note (optional)",
  NOTE_PLACEHOLDER: "What it is for",
  NOTE_TIP_LABEL: "About the note",
  NOTE_TIP: "Written into the Fiber invoice and kept in your node's History. The Lightning invoice is the hub's, with its own text.",
  CREATE: "Create request",
  NEEDS_NODE: "Get paid needs your Fiber node running.",
  OPEN_NODE: "Open your Fiber node",

  /* the request */
  RESULT_LABEL: "Request",
  TABS_LABEL: "Pay with",
  LIGHTNING: "Lightning",
  FIBER: "Fiber",
  STATUS: {
    idle: "Not made yet",
    making: "Making…",
    waiting: "Waiting",
    arriving: "Arriving",
    paid: "Paid",
    expired: "Expired",
    cancelled: "Cancelled",
    returned: "Returned",
    failed: "Failed",
  } satisfies Record<RequestPartStatus, string>,
  MAKING: "Your node makes the invoice…",
  LIGHTNING_MAKING: "The hub and your node make the invoice…",
  /** The Lightning panel's line: the payer pays BTC, the requester never receives BTC. */
  LIGHTNING_LABEL: (symbol: string) => `They pay BTC on Lightning. You receive ${symbol}.`,
  LIGHTNING_TIP_LABEL: "About paying on Lightning",
  LIGHTNING_TIP:
    "Any Lightning wallet pays it in sats. The hub swaps them and pays your node the amount asked, so you never hold BTC. It is made when you open this tab and stays payable for the hub's request time (15 minutes by default); this page asks the hub to cancel it once your request is paid on Fiber or you start a new one. Testnet: on Mutinynet only a wallet with a direct channel to the hub can pay it (LDK's CLTV limits).",
  LIGHTNING_QR_ALT: "QR code of the Lightning invoice to pay",
  THEY_PAY: "They pay",
  SATS: (sats: string) => `${sats} sats`,
  EXPIRES_IN: "Expires in",
  ARRIVING: "Payment held. The hub is paying your node…",
  EXPIRED: "Expired before anyone paid.",
  RETURNED: "The payment went back to the payer.",
  CANCELLED: "The hub cancelled this invoice.",
  FIBER_LABEL: "Pay from a Fiber wallet",
  FIBER_TIP_LABEL: "About paying on Fiber",
  FIBER_TIP: "Any Fiber wallet on CKB testnet pays it straight to your node. Keep your node running until it is paid.",
  FIBER_QR_ALT: "QR code of the Fiber invoice to pay",
  VALID_UNTIL: "Valid until",
  FIBER_ARRIVING: "Payment arriving…",
  NEW_INVOICE: "New invoice",
  NEW_REQUEST: "New request",

  /* the receipt */
  PAID: "Paid",
  PAID_TWICE: "Paid twice",
  PAID_TWICE_TIP_LABEL: "About two payments",
  PAID_TWICE_TIP: "Both invoices were paid, so your node received the amount twice. Send one back from Pay if you need to.",
  RECEIVED: "Received",
  PAID_WITH: "Paid with",
  VIA_LIGHTNING: (sats: string) => `Lightning, ${sats} sats`,
  VIA_FIBER: "Fiber",
  AT: "At",
  DETAIL_LABEL: "About this error",
} as const;

/** Get paid's one-line errors: what is wrong, then what to do. */
export const REQUEST_ERROR = {
  AMOUNT: (symbol: string) => `Enter an amount of ${symbol} above zero.`,
  NOTE: `Keep the note to ${INVOICE_NOTE_MAX_LENGTH} characters.`,
  RANGE: (min: string, max: string) => `On Lightning, requests run from ${min} to ${max} sats.`,
  CANNOT_RECEIVE: (can: string) => `Your node can receive ${can} now. Not enough for this.`,
  NODE_DID_NOT_ANSWER: "Your Fiber node did not answer. Try again.",
} as const;
