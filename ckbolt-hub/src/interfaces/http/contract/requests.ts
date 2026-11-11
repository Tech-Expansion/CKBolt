import { z } from "zod";
import { ASSET_ID_PATTERN } from "../../../common/constants/assets.constants";
import { HTTP_HEADER } from "../../../common/constants/http.constants";
import { QUOTE_PURPOSE } from "../../../common/constants/swap.constants";
import { isFiberNodeId, isLnPubkey, toLnPubkey, toNodeId } from "../../../common/utils/node-id.util";

/**
 * Request bodies of the REST API (v1). This file and responses.ts are the public contract: the CKBolt web app keeps a
 * copy (ckbolt-web/lib/hub/contract.ts). Change both together and bump the API version on breaking changes.
 *
 * Amounts travel as decimal strings of base units (JSON has no bigint).
 */

/**
 * Request headers (names are case-insensitive). With HUB_PROXY_SECRET set on the hub, every request must carry the
 * secret in X-CKBolt-Proxy-Secret, or it answers 401 `unauthorized`. On a request with the secret, X-CKBolt-Client names
 * the visitor the proxy forwards (1 to 128 printable characters once trimmed), and the rate limits and daily caps count
 * that visitor; absent or invalid, they count the request's own address.
 */
export const REQUEST_HEADER = {
  PROXY_SECRET: HTTP_HEADER.PROXY_SECRET,
  CLIENT: HTTP_HEADER.PROXIED_CLIENT,
  /**
   * POST /v1/swaps/:id/cancel: the `cancelToken` POST /v1/swaps answered with. Missing or wrong, the answer is 403
   * cancel_refused.
   */
  CANCEL_TOKEN: HTTP_HEADER.CANCEL_TOKEN,
} as const;

export const directionSchema = z.enum(["ln_to_fiber", "fiber_to_ln"]);
/**
 * A Fiber asset id as GET /v1/assets lists them ("CKB", "RUSD", "CWBTC", or any UDT id the hub's config adds): upper-case
 * letters and digits. A malformed id is 400 validation_failed; a well-formed id the hub does not serve on its network is
 * 422 asset_unavailable.
 */
export const fiberAssetSchema = z.string().regex(ASSET_ID_PATTERN, "must be an asset id as GET /v1/assets lists it, such as CKB");
export const amountSchema = z.string().regex(/^[1-9]\d{0,29}$/, "must be a positive whole number of base units, as a string");
export const uuidSchema = z.string().uuid();
/**
 * A Fiber node id: the node's compressed public key, 33 bytes of hex starting with 02 or 03, with or without 0x. Read as
 * lower-case hex without 0x, the way the hub writes node ids.
 */
export const fiberNodeIdSchema = z
  .string()
  .trim()
  .refine(isFiberNodeId, "must be a Fiber node id: 33 bytes of hex starting with 02 or 03")
  .transform(toNodeId);
/** A Lightning node's public key: 33 bytes of hex starting with 02 or 03. Read as lower-case hex, the way LND writes it. */
export const lnPubkeySchema = z
  .string()
  .trim()
  .refine(isLnPubkey, "must be a Lightning node public key: 33 bytes of hex starting with 02 or 03")
  .transform(toLnPubkey);

/**
 * A quote's purpose, when it is not a swap: `request` asks for a payment request's quote (Get paid's Lightning
 * invoice), which lives REQUEST_QUOTE_TTL_SECONDS (900 by default) instead of QUOTE_TTL_SECONDS, so its hold invoice
 * stays payable while the requester waits for a payer. Leave it out for a swap quote; any other value is 400
 * validation_failed.
 */
export const quotePurposeSchema = z.literal(QUOTE_PURPOSE.REQUEST, {
  errorMap: () => ({ message: `must be "${QUOTE_PURPOSE.REQUEST}", or left out for a swap quote` }),
});

/**
 * POST /v1/quotes. `purpose: "request"` is served for ln_to_fiber only: on fiber_to_ln the answer is 422
 * purpose_unsupported. A swap on a request quote counts toward REQUEST_MAX_OPEN_PER_CLIENT instead of
 * SWAP_MAX_UNPAID_PER_CLIENT while it waits for its payment.
 */
export const createQuoteBodySchema = z.object({
  direction: directionSchema,
  asset: fiberAssetSchema,
  /** Which amount is fixed: what the user pays, or what the user receives. */
  side: z.enum(["pay", "receive"]),
  amount: amountSchema,
  purpose: quotePurposeSchema.optional(),
});
export type CreateQuoteBody = z.infer<typeof createQuoteBodySchema>;

/**
 * POST /v1/swaps. One swap per quote: a second swap on the same quote is 409 conflict. The 201 carries the swap's
 * `cancelToken`, once: keep it to cancel the swap while nobody has paid it (POST /v1/swaps/:id/cancel takes no body).
 *
 * `payoutInvoice` is the invoice the hub pays out to, made by the user's wallet (or the demo wallet). It must:
 * - always: ask for exactly the quote's `receive.amount` (an invoice without an amount is refused: the nodes cannot pay
 *   it), stay valid until at least the quote's `expiresAt`, and carry a payment hash no swap or invoice has used;
 * - ln_to_fiber: be a Fiber invoice on the hub's CKB network (prefix fibd devnet, fibt testnet, fibb mainnet) with
 *   `hash_algorithm: sha256` (both legs share one SHA-256 hash), for the quote's asset (CKB, or the UDT's type script),
 *   with a final expiry delta of at least 160 minutes that the hub's timing can fit;
 * - fiber_to_ln: be a BOLT11 invoice for the hub's Bitcoin network (lnbcrt regtest, lntbs signet such as Mutinynet,
 *   lntb testnet3 and testnet4, lnbc mainnet) whose CLTV expiry the hub's timing can fit.
 * Otherwise the answer is 422 invoice_invalid (400 when the string is not an invoice at all) with a plain sentence.
 */
export const createSwapBodySchema = z.object({
  quoteId: uuidSchema,
  /** Fiber invoice (ln_to_fiber) or BOLT11 invoice (fiber_to_ln) the hub pays out to; rules above. */
  payoutInvoice: z.string().trim().min(1).max(4_096),
  /**
   * Ignored, kept so older clients stay valid: the hub itself finds out whether the payout invoice is the demo wallet's
   * (the swap's `demo`).
   */
  demo: z.boolean().optional(),
});
export type CreateSwapBody = z.infer<typeof createSwapBodySchema>;

/** POST /v1/demo/invoices: the demo wallet makes the payout invoice for a swap it will receive. */
export const createDemoInvoiceBodySchema = z.object({
  direction: directionSchema,
  asset: fiberAssetSchema,
  /** Payout leg amount in its base units: sats for fiber_to_ln, asset base units for ln_to_fiber. */
  amount: amountSchema,
});
export type CreateDemoInvoiceBody = z.infer<typeof createDemoInvoiceBodySchema>;

/** POST /v1/demo/payments: the demo wallet pays the swap's hold invoice. */
export const createDemoPaymentBodySchema = z.object({
  swapId: uuidSchema,
});
export type CreateDemoPaymentBody = z.infer<typeof createDemoPaymentBodySchema>;

/**
 * POST /v1/fiber/inbound-channels: the hub's Fiber node opens a channel in `asset` to the node `nodeId`, which must
 * already be connected to it (dialled one of GET /v1/fiber/node's addresses), so that node can receive a payout.
 */
export const createInboundChannelBodySchema = z.object({
  nodeId: fiberNodeIdSchema,
  asset: fiberAssetSchema,
});
export type CreateInboundChannelBody = z.infer<typeof createInboundChannelBodySchema>;

/**
 * POST /v1/lightning/inbound-channels: the hub's Lightning node opens a private channel, part of it pushed to the
 * wallet's side, to the wallet `pubkey`, which must already be connected to it as a peer (one of GET
 * /v1/lightning/node's `uris`), so the wallet can pay the hub directly.
 */
export const createLightningInboundChannelBodySchema = z.object({
  pubkey: lnPubkeySchema,
});
export type CreateLightningInboundChannelBody = z.infer<typeof createLightningInboundChannelBodySchema>;
