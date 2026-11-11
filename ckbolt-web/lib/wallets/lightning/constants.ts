/**
 * Facts and tunables of the Lightning side of a live swap. The visitor pays and gets paid with any Lightning wallet, by
 * QR code or pasted invoice; a WebLN extension (`window.webln`, such as Alby) may also pay the hub's hold invoice from
 * the page. Background: ../ckbolt-hub/docs/research/lightning-wallets.md.
 */

/** Event a WebLN extension (Alby) fires on `window` once it has injected `window.webln`. */
export const WEBLN_READY_EVENT = "webln:ready";

/**
 * WebLN rejection messages that mean nothing was sent (the visitor refused, or the site was not allowed). WebLN has no
 * error codes, so any other rejection of a payment counts as "maybe sent". Matched case-insensitively as substrings.
 */
export const WEBLN_DECLINED_MESSAGES = ["user rejected", "provider must be enabled"] as const;

/** The code given to a WebLN refusal, which has none: the visitor or the extension said no, so nothing was sent. */
export const WEBLN_DECLINED_CODE = "USER_REJECTED";

/** A wallet's error text is shown to the visitor up to this many characters. */
export const WALLET_MESSAGE_MAX_CHARS = 200;

/**
 * Words in a wallet's payment error that mean it found no route to the hub, matched case-insensitively. LDK wallets
 * such as Alby Hub answer `RouteNotFound` or `PaymentSendingFailed`: on Mutinynet they can pay the hub only over a
 * channel with it, so the page points to a channel from the hub.
 */
export const NO_ROUTE_ERROR_MARKERS = ["routenotfound", "paymentsendingfailed"] as const;

export const MSAT_PER_SAT = 1_000;

/** The URI scheme a Lightning wallet opens ("Open in wallet"), before the BOLT11 invoice. */
export const LIGHTNING_URI_SCHEME = "lightning:";

/** BOLT11 prefixes by the hub's Lightning network family, for the pasted invoice's placeholder. */
export const BOLT11_PREFIX = { mainnet: "lnbc", testnet: "lntb", signet: "lntbs", regtest: "lnbcrt" } as const;
