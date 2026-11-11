/**
 * Plain sentences of the Lightning side: what is wrong, then what to do (docs/style-guide.md, Copy). Lines the swap card
 * shows keep to twelve words a sentence. Network names come in already labelled, such as "Bitcoin signet"
 * (lib/hub/format.ts `lightningNetworkLabel`).
 */
export const LN_WALLET_MESSAGE = {
  /* the browser wallet (WebLN) paying the hub's hold invoice */
  WEBLN_REFUSED: "Your browser wallet did not allow CKBolt. Allow it in the extension, then try again.",

  /* the visitor's own invoice, pasted or scanned (fiber_to_ln) */
  INVOICE_NOT_LIGHTNING: "This is not a Lightning invoice.",
  INVOICE_MAINNET: (hubNetwork: string) => `This is a mainnet invoice. Use one on ${hubNetwork}.`,
  INVOICE_WRONG_NETWORK: (invoiceNetwork: string, hubNetwork: string) => `This invoice is for ${invoiceNetwork}. Use one on ${hubNetwork}.`,
  INVOICE_NO_AMOUNT: "This invoice has no amount. Make one with an amount.",
  INVOICE_PART_SAT: "This invoice asks for part of a sat. Use whole sats.",
  INVOICE_NO_HASH: "This invoice has no payment hash. Make a new one.",
  INVOICE_EXPIRED: "This invoice has expired. Make a new one.",
  INVOICE_EXPIRES_TOO_SOON: "This invoice expires before the quote. Make a new one.",

  /* the hub's hold invoice (ln_to_fiber) */
  HOLD_INVOICE_MISMATCH: "The hub's invoice does not match this swap, so CKBolt does not show it.",

  /* a Lightning channel from the hub (./hub-channel.ts), on the guide's hub card */
  CHANNEL_NODE_ID_INVALID: "Paste your node id: 66 hex characters, starting 02 or 03.",
  CHANNEL_ADD_PEER: "Add the hub as a peer in your wallet first, then try again.",
  CHANNEL_DISABLED: "The hub does not open Lightning channels right now.",
  CHANNEL_LIMIT: "The hub's channel limit is reached. Try again later.",
  CHANNEL_NO_FUNDS: "The hub has no funds for a new channel right now. Try again later.",
  CHANNEL_PAUSED: "The hub is paused for maintenance. Try again later.",
  CHANNEL_KEY_REFUSED: "The hub did not accept this node id.",
  CHANNEL_HUB_UNREACHABLE: "The hub did not answer. Try again.",
  CHANNEL_FAILED: "The hub could not open a channel. Try again later.",

  /* fallbacks */
  /** The hub's network in a sentence when its health does not name one. */
  UNKNOWN_HUB_NETWORK: "a Bitcoin test network",
  WALLET_ERROR_FALLBACK: "the wallet gave no reason.",
} as const;
