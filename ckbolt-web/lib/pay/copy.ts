/**
 * Every line Pay shows on /app (docs/pay-get-paid.md, part B). Few words on screen, no sentence over 12 words; the rest
 * behind a "?" (docs/style-guide.md, Copy).
 */

export const PAY_COPY = {
  TITLE: "Pay",
  NETWORK_TAG: "Testnet",
  INPUT_LABEL: "Invoice or address",
  INPUT_TIP_LABEL: "What you can pay",
  INPUT_TIP:
    "A Lightning invoice with an amount: your Fiber node pays it in CKB or a token the hub serves, through the hub. A Fiber invoice: your node pays it over Fiber, through the hub when it has no route of its own. A CKB address: your node sends CKB on chain. You confirm each payment in your Fiber node.",
  INPUT_PLACEHOLDER: "lntbs…, fibt… or ckt1…",
  SCAN: "Scan a QR code",
  SCAN_CLOSE: "Close the scanner",
  CLEAR: "Clear",
  KIND: { lightning: "Lightning invoice", fiber: "Fiber invoice", "ckb-address": "CKB address" },

  /* the browser node */
  NEEDS_NODE: "Pay needs your Fiber node running.",
  OPEN_NODE: "Open your Fiber node",

  /* a Lightning invoice: a CKB or a token to BTC swap, exact out */
  MERCHANT_GETS: "They get",
  YOU_PAY: "You pay",
  FEE: "Fee",
  FEE_TIP_LABEL: "About the fee",
  FEE_TIP: "The hub's spread and price-risk premium, already in what you pay. Your node pays the hub over Fiber; the hub pays this invoice on Lightning.",
  QUOTE: "Quote",
  PAY_WITH: "Pay with",
  TOKEN_SIDE: "You pay",

  /* a Fiber invoice */
  AMOUNT: "Amount",
  TO: "To",
  UNKNOWN_PAYEE: "Not named",
  MAX_FEE: "Max fee",
  MAX_FEE_TIP_LABEL: "About the max fee",
  MAX_FEE_TIP: "The most routing may cost: 0.5 % of the amount, enforced by your node. The fee it took shows once paid.",
  EXPIRES: "Expires",
  ROUTE: "Route",
  ROUTE_KIND: { direct: "Direct", hub: "Through the CKBolt hub" },
  ROUTE_TIP_LABEL: "About the route",
  ROUTE_TIP:
    "Your node tried a route first, without paying. Direct: it found its own path to the payee. Through the CKBolt hub: it pays the hub, and the hub finds the path on (trampoline routing). The payment stays locked to the same hash, so the hub cannot keep it: the payee gets it, or it comes back. The hub learns who you paid; the max fee covers its part.",
  READING: "Your node reads the invoice…",
  ACTUAL_FEE: "Fee paid",
  FEE_OF_MAX: (fee: string, max: string) => `${fee} (max ${max})`,
  PAYMENT_HASH: "Payment hash",
  COPY_HASH: "Copy payment hash",

  /* a CKB address */
  AMOUNT_LABEL: "Amount (CKB)",
  AMOUNT_PLACEHOLDER: "0",
  ON_CHAIN: (ckb: string) => `On chain: ${ckb} CKB`,
  NETWORK_FEE: "Network fee",
  TRANSACTION: "Transaction",
  COPY_TX: "Copy transaction hash",
  EXPLORER: "View on CKB Explorer (testnet)",

  /* confirm, waiting, results */
  CONFIRM_PAY: (amount: string) => `Pay ${amount}`,
  CONFIRM_SEND: (amount: string) => `Send ${amount}`,
  REFRESH_QUOTE: "Refresh quote",
  GETTING_QUOTE: "Getting quote…",
  CONFIRM_IN_NODE: "Confirm it in your Fiber node.",
  CONFIRM_IN_NODE_PASSWORD: "Confirm it in your Fiber node, with its password.",
  SHOW_NODE: "Show",
  PAID: "Paid",
  SENDING: "Sending…",
  FAILED: "Payment failed",
  SENT_ON_CHAIN: (amount: string) => `Sent ${amount}`,
  SENT_ON_CHAIN_LINE: "It arrives once the transaction confirms.",
  NEW_PAYMENT: "New payment",
  RETRY: "Try again",
  NEW_QUOTE: "Get a new quote",
  RESULT_LABEL: "Payment",
  DETAIL_LABEL: "About this error",
} as const;

/** Pay's one-line errors: what is wrong, then what to do. */
export const PAY_ERROR = {
  NOT_PAYABLE: "Paste a Lightning or Fiber invoice, or a CKB address.",
  CKB_WRONG_NETWORK: (network: string) => `This address is not on CKB ${network}. Use a CKB ${network} address.`,
  AMOUNT: "Enter an amount of CKB above zero.",
  OVER_BALANCE: (ckb: string) => `Your node holds ${ckb} CKB on chain. Send less.`,
  EXPIRED: "This invoice has expired. Ask for a new one.",
  CANNOT_SEND: (amount: string) => `Your node can send ${amount} now. Not enough for this.`,
  NODE_DID_NOT_ANSWER: "Your Fiber node did not answer. Check its History.",
  /** The node's dry runs found no route, its own nor through the hub; fnn's reason goes behind the "?". */
  NO_ROUTE: "No route to this payee now. Their node may be offline.",
} as const;
