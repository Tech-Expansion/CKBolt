import { z } from "zod";
import { KUCOIN_API } from "../../common/constants/price-sources.constants";
import { PriceSourceError } from "./price-source.error";

/**
 * Shapes of the price APIs' answers. Anything else is rejected, so a changed or broken API cannot feed a quote.
 */

const DECIMAL_NUMBER = /^\d+(?:\.\d+)?$/;

/** A USD price, as a JSON number or a decimal string: positive and finite. */
const usdPriceSchema = z
  .union([z.number(), z.string().regex(DECIMAL_NUMBER)])
  .transform(Number)
  .pipe(z.number().finite().positive());

const timestampSchema = z.number().int().positive();

/** One coin of CoinGecko /simple/price; `last_updated_at` is in seconds. */
export const coinGeckoCoinSchema = z.object({ usd: usdPriceSchema, last_updated_at: timestampSchema.optional() });

/** CoinGecko /simple/price: an object keyed by coin id (COINGECKO_API.coinIds); each coin is checked on its own. */
export const coinGeckoPayloadSchema = z.record(z.unknown());

/** Binance /ticker/price for one symbol; must echo the symbol asked for. */
export const binanceTickerSchema = (symbol: string) => z.object({ symbol: z.literal(symbol), price: usdPriceSchema });

/** KuCoin level-1 order book for one symbol; `data.time` is in ms. An unknown symbol answers `data: null`. */
export const kuCoinLevel1Schema = z.object({
  code: z.literal(KUCOIN_API.successCode),
  data: z.object({ price: usdPriceSchema, time: timestampSchema.optional() }),
});

/** A PriceSourceError for an answer of the wrong shape. */
export const unexpectedPayload = (sourceName: string): PriceSourceError => new PriceSourceError(`${sourceName} answered with an unexpected payload.`);

/** `payload` parsed by `schema`, or a PriceSourceError naming the source. */
export function parsePayload<T extends z.ZodTypeAny>(schema: T, payload: unknown, sourceName: string): z.output<T> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw unexpectedPayload(sourceName);
  return parsed.data;
}
