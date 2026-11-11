/**
 * Every line the live swap card and its progress dialog show (docs/live-swap-ui.md). The card reads like a DEX: no
 * sentence over 12 words on screen, and anything longer lives in an InfoTip or the How it works dialog.
 */

export const CARD_COPY = {
  TITLE: "Swap",
  NETWORK_TAG: "Testnet",
  PAY_LABEL: "You pay",
  RECEIVE_LABEL: "You receive",
  AMOUNT_PLACEHOLDER: "0",
  /** Shown where an amount is not known yet. */
  EMPTY_AMOUNT: "—",
  LOADING_AMOUNT: "…",
  FLIP: "Switch direction",
  FLIP_BLOCKED: "Switch direction: the hub does not swap this pair the other way",
  MAX_SATS: (sats: string) => `Max ${sats} sats`,
  CAN_SEND: (amount: string, symbol: string) => `Can send ${amount} ${symbol}`,
  USD_HINT: (usd: string) => `≈ ${usd}`,
  TOKEN_BUTTON: (side: string, symbol: string) => `${side} ${symbol}, change token`,
  TOKEN_LIST: (side: string) => `${side}: choose a token`,
  NO_TOKEN: "Select",
} as const;

export const DETAILS_COPY = {
  TOGGLE: "Details",
  FEE: "Fee",
  FEE_TIP_LABEL: "About the hub fee",
  FEE_TIP: "The hub's spread and price-risk premium. It is already in the amounts.",
  TIMER_LABEL: (seconds: number) => `Quote expires in ${seconds} seconds`,
  TIMER_EXPIRED_LABEL: "Quote expired",
  EXPIRED: "Expired",
  ROUTE: "Route",
  ROUTE_LN_TO_FIBER: "Lightning → CKBolt hub → Fiber",
  ROUTE_FIBER_TO_LN: "Fiber → CKBolt hub → Lightning",
  PER_SWAP: "Per swap",
  PER_SWAP_VALUE: (min: string, max: string) => `${min} to ${max} sats`,
  PRICE: "Price",
  PRICE_VALUE: (source: string, time: string) => `${source}, ${time}`,
} as const;

/** Labels of the primary button, one per state of docs/live-swap-ui.md "The primary button". */
export const PRIMARY_LABEL = {
  RUNNING: "Swap in progress",
  VIEW_RESULT: "View result",
  HUB_UNAVAILABLE: "Hub unavailable",
  /** The hub's maintenance switch: no new quotes or swaps. */
  PAUSED: "Swaps paused",
  ENTER_AMOUNT: "Enter an amount",
  INVALID_AMOUNT: "Enter a valid amount",
  MIN: (sats: string) => `Min ${sats} sats`,
  MAX: (sats: string) => `Max ${sats} sats`,
  NO_LIQUIDITY: "Not enough liquidity",
  OUT_OF_RANGE: "Amount out of range",
  CONNECT_FIBER: "Connect Fiber node",
  FIBER_NOT_READY: "Open your Fiber node",
  SHORT_TO_SEND: (symbol: string) => `Not enough ${symbol} to send`,
  SHORT_TO_RECEIVE: (symbol: string) => `Your node can't receive this much ${symbol}`,
  NO_CHANNEL: "Ask the hub for a channel first",
  PASTE_LN_INVOICE: "Paste your Lightning invoice",
  PASTE_FIBER_INVOICE: "Paste your Fiber invoice",
  QUOTE_LOADING: "Getting quote…",
  QUOTE_EXPIRED: "Refresh quote",
  QUOTE_FAILED: "Try again",
  READY: "Swap",
} as const;

/** The card's one error line. */
export const CARD_ERROR = {
  RANGE: (min: string, max: string) => `Swaps run from ${min} to ${max} sats.`,
  LIQUIDITY: "The hub cannot pay out this much right now.",
  NO_PRICE: "No fresh price right now. Try again soon.",
  RATE_LIMITED: "Too many requests. Try again in a minute.",
  HUB_UNREACHABLE: "The hub did not answer. Try again.",
  ASSET_UNAVAILABLE: "The hub does not swap this token now.",
  MAINTENANCE: "Swaps are paused for maintenance. Try again later.",
  QUOTE_FAILED: "The hub could not quote this amount.",
  DETAIL_LABEL: "About this error",
} as const;

export const OWN_INVOICE_COPY = {
  LABEL: "Your Fiber invoice",
  TIP_LABEL: "About your Fiber invoice",
  TIP: (amount: string) => `Make a sha256 invoice in your node for exactly ${amount}, valid longer than the quote. The command below makes one.`,
  TIP_NO_QUOTE: "Make a sha256 invoice in your node for exactly the amount you receive. Enter an amount to get the command.",
  PLACEHOLDER: (prefix: string) => `${prefix}…`,
  INVALID: "This invoice does not match the quote.",
} as const;

/**
 * External node: the fnn JSON-RPC call for its step as a copyable curl line (lib/wallets/fiber-byo/rpc-commands.ts),
 * under a disclosure so the card stays short for people who use Fiber Studio's screens.
 */
export const NODE_COMMAND_COPY = {
  INVOICE_LABEL: "Make it with fnn",
  INVOICE_TIP: (rpc: string) =>
    `Runs new_invoice on your fnn (RPC at ${rpc}) with sha256, this exact amount and token. Paste the invoice_address it returns above. In Fiber Studio, use the same values.`,
  PAY_LABEL: "Pay it with fnn",
  PAY_TIP: (rpc: string, fee: string) =>
    `Runs send_payment on your fnn (RPC at ${rpc}), with at most ${fee} in fees. Keep the node online until the swap completes.`,
  COPY: "Copy command",
} as const;

/** CKB or a token to BTC: the visitor's own Lightning invoice, pasted or scanned; its amount fixes the swap. */
export const LN_INVOICE_COPY = {
  LABEL: "Your Lightning invoice",
  TIP_LABEL: "About your Lightning invoice",
  TIP: (network: string) => `Make an invoice with an amount in any Lightning wallet on ${network}. Paste or scan it here. Its amount sets what you pay.`,
  /** Under the field, once a typed amount was quoted: the invoice to make. */
  ASK: (sats: string) => `For exactly ${sats} sats`,
  PLACEHOLDER: (prefix: string) => `${prefix}…`,
  SCAN: "Scan a QR code",
  SCAN_CLOSE: "Close the scanner",
} as const;

/** Step titles of the run, by direction where they differ. */
export const STEP_TITLE = {
  invoice: { ln_to_fiber: "Invoice from your Fiber node", fiber_to_ln: "Your invoice" },
  lock: "Swap locked with the hub",
  pay: { ln_to_fiber: "Pay from your Lightning wallet", fiber_to_ln: "Pay from your Fiber node" },
  payout: "The hub pays you",
  complete: "Complete",
} as const;

/** The one short line under each step. */
export const STEP_LINE = {
  INVOICE_MAKING: "Asking your wallet…",
  INVOICE_MADE: "Invoice ready",
  INVOICE_PASTED: "Your pasted invoice",
  LOCKING: "Locking the quote…",
  LOCKED: "Locked",
  PAYING: "Paying from your wallet…",
  SENT: "Sent; waiting for the hub",
  /** The visitor pays the hold invoice shown under the steps: from any Lightning wallet, or from their own Fiber node. */
  MANUAL: { ln_to_fiber: "Pay the invoice below", fiber_to_ln: "Pay the invoice below from your node" },
  HELD: "The hub holds your payment",
  EXPIRED: "The quote expired before payment",
  NOT_PAID: "Nothing was paid",
  PAYING_OUT: "Paying you out…",
  PAID_OUT: "Paid out",
  PAYOUT_FAILED: "Payout failed",
  SETTLING: "Settling…",
  COMPLETE: "Swap complete",
  REFUNDED: "Refunded",
  REFUND_PENDING: "Refund pending…",
  CANCELLED: "Cancelled",
  CANCELLING: "Cancelling…",
} as const;

/** The guide's hub card part that gets a Lightning channel from the hub; the progress dialog points to it by this name. */
export const LIGHTNING_CHANNEL_TITLE = "Get a Lightning channel from the hub";

/** What each way forward beside an error line (lib/swap/errors.ts `ErrorHelp`) reads. */
export const ERROR_HELP_LABEL = {
  "lightning-channel": LIGHTNING_CHANNEL_TITLE,
} as const;

/** Short errors of the run's steps; the full reason, when there is one, goes behind a "?". */
export const RUN_ERROR = {
  LN_PASTE_INVOICE: "Paste your Lightning invoice on the card.",
  FIBER_PASTE_INVOICE: "Paste your Fiber invoice on the card.",
  QUOTE_EXPIRED: "The quote expired. Get a new one.",
  QUOTE_TAKEN: "This quote already has a swap. Get a new one.",
  INVOICE_REFUSED: "The hub refused the payout invoice.",
  HUB_UNREACHABLE: "The hub did not answer. Try again.",
  RATE_LIMITED: "Too many requests. Try again in a minute.",
  SWAP_FAILED: "The hub could not start the swap.",
  /** The browser wallet (WebLN) refused; its own words go behind a "?". */
  WALLET_DECLINED: "Your browser wallet did not pay.",
  /** An LDK wallet (Alby Hub) with no channel to the hub: the dialog points to a channel from the hub. */
  NO_ROUTE: "Your wallet found no route to the hub.",
  MAINTENANCE: "Swaps are paused for maintenance.",
  NODE_NO_TAB: "Open your Fiber node, then try again.",
  NODE_LOCKED: "Unlock your Fiber node, then try again.",
  NODE_WRONG_NETWORK: "Your node runs on another CKB network.",
  NODE_NO_INBOUND: "Your node cannot receive this much yet.",
  NODE_NO_OUTBOUND: "Your node cannot send this much yet.",
  NODE_REFUSED: "Your node refused this payment.",
  NODE_FAILED: "Your Fiber node could not do this.",
  DETAIL_LABEL: "About this error",
} as const;

/** The progress dialog. */
export const PROGRESS_COPY = {
  TITLE_RUNNING: "Swapping",
  /** Once the run has ended; the result under the steps says how. */
  TITLE_ENDED: "Swap",
  PAIR: (pay: string, receive: string) => `${pay} to ${receive}`,
  STEPS_LABEL: "Swap steps",
  STEP_STATUS: { pending: "Pending", active: "In progress", done: "Done", failed: "Failed" },
  HIDE: "Hide",
  RETRY: "Try again",
  NEW_QUOTE: "Get a new quote",
  NEW_SWAP: "New swap",
  POLL_ERROR: "Can't reach the hub. Retrying…",
  MANUAL_LABEL: "Pay this from your Fiber node",
  MANUAL_TIP_LABEL: "About paying from your own node",
  MANUAL_TIP: "Paste it in Fiber Studio or call send_payment on your fnn. Keep the node online.",
  MANUAL_QR_ALT: "QR code of the hub's Fiber invoice to pay",
  COPY_INVOICE: "Copy invoice",
  /** BTC to CKB or a token: the hub's Lightning hold invoice, paid from any wallet. */
  HOLD_LABEL: "Pay this from any Lightning wallet",
  HOLD_TIP_LABEL: "About paying this invoice",
  HOLD_TIP: "Scan the code, copy the invoice, or open it in a wallet on this device. The hub holds your payment until it pays you.",
  HOLD_QR_ALT: "QR code of the hub's Lightning invoice to pay",
  OPEN_IN_WALLET: "Open in wallet",
  PAY_IN_BROWSER: "Pay with browser wallet",
} as const;

/** How a run ended, as the dialog and the card's banner say it. */
export const RESULT_COPY = {
  COMPLETE: "Swap complete",
  REFUNDED: "Refunded: your payment went back to your wallet",
  REFUNDED_SHORT: "Refunded",
  REFUND_PENDING: "Refund pending",
  REFUND_PENDING_LINE: "Your payment returns when the hub cancels the hold.",
  CANCELLED: "Swap cancelled",
  CANCELLING: "Cancelling",
  CANCELLED_LINE: "Nothing was paid.",
  PAID: "Paid",
  RECEIVED: "Received",
  DETAILS: "Details",
  SWAP_ID: "Swap id",
  PAYMENT_HASH: "Payment hash",
  PREIMAGE: "Preimage",
  HASH_CHECK: "sha256(preimage) = payment hash",
  HASH_MATCH: "Checked in this page",
  HASH_MISMATCH: "Does not match",
  HASH_UNCHECKED: "Not checked: this browser has no Web Crypto here",
  HASH_CHECKING: "Checking…",
  REASON: "Hub's reason",
} as const;

export const BANNER_COPY = {
  RUNNING: "Swap in progress",
  VIEW: "View",
} as const;

