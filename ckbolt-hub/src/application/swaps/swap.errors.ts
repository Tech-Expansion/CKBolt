import { HttpStatus } from "@nestjs/common";
import { API_ERROR_CODE, RESOURCE_NAME } from "../../common/constants/api.constants";
import { FIBER_HASH_ALGORITHM_SHA256 } from "../../common/constants/protocol.constants";
import { HubError, NotFoundError, QuoteAlreadyUsedError, RateLimitedError } from "../../common/errors/hub.error";
import { toIso } from "../../common/utils/time.util";
import { LEG_NETWORK_NAME, legNetworks } from "../../domain/swap";
import type { Direction } from "../../domain/types";

/** A payout invoice the hub cannot serve: valid input, so 422 (architecture.md, REST API v1). */
const invoiceInvalid = (message: string, cause?: unknown): HubError =>
  new HubError(message, HttpStatus.UNPROCESSABLE_ENTITY, API_ERROR_CODE.INVOICE_INVALID, { cause });

/** Every error creating a swap can show the user. The only place these messages are written. */
export const SWAP_ERROR = {
  quoteNotFound: (): HubError => new NotFoundError(RESOURCE_NAME.QUOTE),

  swapNotFound: (): HubError => new NotFoundError(RESOURCE_NAME.SWAP),

  /** The signature no longer verifies, e.g. the hub restarted with a new signing key. */
  quoteInvalid: (): HubError =>
    new HubError(
      "This quote can no longer be honoured. Ask for a new quote.",
      HttpStatus.UNPROCESSABLE_ENTITY,
      API_ERROR_CODE.QUOTE_UNAVAILABLE,
    ),

  quoteExpired: (): HubError =>
    new HubError("This quote has expired. Ask for a new quote.", HttpStatus.UNPROCESSABLE_ENTITY, API_ERROR_CODE.QUOTE_EXPIRED),

  assetNotServed: (asset: string): HubError =>
    new HubError(
      `The hub no longer swaps ${asset} on this network. Ask for a new quote.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      API_ERROR_CODE.ASSET_UNAVAILABLE,
    ),

  /** One swap per quote (409). */
  quoteAlreadyUsed: (): HubError => new QuoteAlreadyUsedError(),

  /** The client has as many swaps waiting for their payment as it may (429; Retry-After: when the first can expire). */
  tooManyUnpaidSwapsFromClient: (cap: number, retryAfterSeconds: number): HubError =>
    new RateLimitedError(
      `This client already has ${cap} swaps waiting for their payment. Pay one of them or let it expire, then try again.`,
      retryAfterSeconds,
    ),

  /**
   * The client has as many payment requests (swaps on request quotes) waiting for their payment as it may
   * (REQUEST_MAX_OPEN_PER_CLIENT; 429; Retry-After: when the first can expire).
   */
  tooManyOpenRequestsFromClient: (cap: number, retryAfterSeconds: number): HubError =>
    new RateLimitedError(
      `This client already has ${cap} payment requests waiting for their payment. Wait until one is paid or expires, then try again.`,
      retryAfterSeconds,
    ),

  /** Every client together has as many swaps waiting for their payment as the hub allows (429). */
  tooManyUnpaidSwaps: (retryAfterSeconds: number): HubError =>
    new RateLimitedError("The hub has too many swaps waiting for their payment right now. Try again in a few minutes.", retryAfterSeconds),

  /**
   * The swaps waiting for their payment hold their whole share (SWAP_MAX_UNPAID_SHARE_PERCENT) of the liquidity that
   * pays out `direction` (503: the hub cannot take it now, though nothing is wrong with the request).
   */
  unpaidShareReached: (direction: Direction): HubError =>
    new HubError(
      `Swaps waiting for their payment already hold as much of the hub's ${LEG_NETWORK_NAME[legNetworks(direction).outgoing]} liquidity as they may. ` +
        "Try a smaller amount, or try again in a few minutes.",
      HttpStatus.SERVICE_UNAVAILABLE,
      API_ERROR_CODE.INSUFFICIENT_LIQUIDITY,
    ),

  /**
   * POST /v1/swaps/:id/cancel without the swap's cancel token (403). One answer for a token that is missing or wrong and
   * for a swap made before cancel tokens existed, given before the swap's state is looked at, so it says nothing GET
   * /v1/swaps/:id does not.
   */
  cancelRefused: (): HubError =>
    new HubError("This request does not carry the swap's cancel token.", HttpStatus.FORBIDDEN, API_ERROR_CODE.CANCEL_REFUSED),

  /** A payment is held or on its way, or the swap has moved on (409): the swap goes on by itself. */
  cancelTooLate: (): HubError =>
    new HubError("This swap can no longer be cancelled: a payment arrived, or it has ended.", HttpStatus.CONFLICT, API_ERROR_CODE.CONFLICT),

  /** Bad input (400), like the node adapters' own "cannot be read" errors. */
  invoiceUnreadable: (network: string, cause?: unknown): HubError =>
    new HubError(
      `The payout invoice could not be read. For this swap it must be a ${network} invoice.`,
      HttpStatus.BAD_REQUEST,
      API_ERROR_CODE.INVOICE_INVALID,
      { cause },
    ),

  invoiceWrongNetwork: (network: string, invoiceNetwork: string, hubNetwork: string): HubError =>
    invoiceInvalid(
      `This ${network} invoice is for ${invoiceNetwork}, but the hub pays out on ${hubNetwork}. Make a ${hubNetwork} invoice.`,
    ),

  fiberHashAlgorithm: (hashAlgorithm: string): HubError =>
    invoiceInvalid(
      `This Fiber invoice uses the ${hashAlgorithm} hash algorithm. Make one with the ${FIBER_HASH_ALGORITHM_SHA256} hash ` +
        "algorithm, so both legs of the swap share one payment hash.",
    ),

  fiberAssetMismatch: (symbol: string): HubError =>
    invoiceInvalid(`This Fiber invoice is not for ${symbol}. Make an invoice for ${symbol}, the asset in the quote.`),

  /** The hub pays out in one part: parts of an MPP payout could be held back by the payee after the payment failed. */
  fiberInvoiceAllowsMpp: (): HubError =>
    invoiceInvalid("This Fiber invoice allows multi-part payments. Make one without allow_mpp: the hub pays out in a single part."),

  /** The nodes pay only invoices that state their amount, so the payout invoice must carry the quoted one. */
  invoiceAmountMissing: (quotedAmount: string): HubError =>
    invoiceInvalid(`This invoice has no amount. Make an invoice for exactly ${quotedAmount}, the amount the quote pays out.`),

  invoiceAmountMismatch: (invoiceAmount: string, quotedAmount: string): HubError =>
    invoiceInvalid(`This invoice asks for ${invoiceAmount}, but the quote pays out ${quotedAmount}. Make an invoice for exactly ${quotedAmount}.`),

  invoiceExpired: (): HubError => invoiceInvalid("This invoice has expired. Make a new one."),

  invoiceExpiresBeforeQuote: (quoteExpiresAt: number): HubError =>
    invoiceInvalid(`This invoice expires before the quote does. Make one that stays valid until at least ${toIso(quoteExpiresAt)}.`),

  /** The timing policy refused the invoice; `reason` is its plain sentence (TIMING_REASON). */
  timingOutOfRange: (reason: string): HubError => invoiceInvalid(reason),

  /** Not for users: the step that needs the block height fails and the next pass tries again. */
  lightningNotSynced: (): Error =>
    new Error("The hub's Lightning node is not synced to the chain, so its block height cannot size a lock yet."),

  nodeUnavailable: (network: string, cause?: unknown): HubError =>
    new HubError(
      `The hub's ${network} node is not answering right now. Try again in a minute.`,
      HttpStatus.SERVICE_UNAVAILABLE,
      API_ERROR_CODE.UPSTREAM_UNAVAILABLE,
      { cause },
    ),
} as const;
