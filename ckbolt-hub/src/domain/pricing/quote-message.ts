import { QUOTE_MESSAGE_PREFIX } from "../../common/constants/pricing.constants";
import { QUOTE_PURPOSE } from "../../common/constants/swap.constants";
import { toDecimalString } from "../../common/utils/amount.util";
import type { QuotePurpose } from "../types";
import type { UnsignedQuote } from "./pricing.types";

/**
 * Every signed field as JSON-safe values. A Record over the keys, so adding a Quote field fails to compile until it is
 * listed. `undefined` leaves a field out of the JSON.
 */
type SignedQuoteFields = Record<keyof UnsignedQuote, string | number | undefined>;

/**
 * `purpose` is signed only when it is not `swap`, so a swap quote's message stays what it was before quotes had a
 * purpose: a quote made just before an upgrade still verifies after it, and the format version is unchanged.
 */
const signedPurpose = (purpose: QuotePurpose): QuotePurpose | undefined => (purpose === QUOTE_PURPOSE.SWAP ? undefined : purpose);

/**
 * The exact bytes the hub signs for a quote: a versioned prefix and the JSON of every field except `signature` and
 * `hubPubkey`, in this fixed order, with amounts as decimal strings (`purpose` only on a request quote, after `feeBps`).
 * Accepts a signed Quote too; those two fields are ignored.
 */
export function canonicalQuoteMessage(quote: UnsignedQuote): string {
  const fields: SignedQuoteFields = {
    id: quote.id,
    direction: quote.direction,
    asset: quote.asset,
    sats: toDecimalString(quote.sats),
    fiberAmount: toDecimalString(quote.fiberAmount),
    btcUsd: quote.btcUsd,
    assetUsd: quote.assetUsd,
    priceSource: quote.priceSource,
    priceAt: quote.priceAt,
    feeBps: quote.feeBps,
    purpose: signedPurpose(quote.purpose),
    createdAt: quote.createdAt,
    expiresAt: quote.expiresAt,
  };
  return `${QUOTE_MESSAGE_PREFIX}${JSON.stringify(fields)}`;
}
