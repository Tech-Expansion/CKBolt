import type { Clock } from "../../src/application/ports/clock.port";
import type { CoinUsdPrice, PriceSource, UsdPrices } from "../../src/application/ports/prices.port";

/** A coin's price as the fake has it: a number, or null for a coin whose feed is down at this source. */
type FakeCoinPrice = number | null;

/**
 * A price source with fixed or scripted prices. Defaults: 1 BTC = $80,000, 1 CKB = $0.002 (1 BTC = 40,000,000 CKB).
 * Prices are stamped with `clock`: a FakeClock in unit tests, the system clock against real nodes (test/e2e). Like the
 * real sources, a coin set to null is left out of the answer (that coin's feed is down) and the source fails only when
 * it has no coin at all, or while `failing` is set.
 */
export class FakePriceSource implements PriceSource {
  failing = false;

  constructor(
    readonly name: string,
    private readonly clock: Clock,
    public prices: { btc: FakeCoinPrice; ckb: FakeCoinPrice; ageMs?: number } = { btc: 80_000, ckb: 0.002 },
  ) {}

  async fetch(): Promise<UsdPrices> {
    if (this.failing || (this.prices.btc === null && this.prices.ckb === null)) throw new Error(`${this.name} is down`);
    return { source: this.name, btc: this.coin(this.prices.btc), ckb: this.coin(this.prices.ckb) };
  }

  private coin(usd: FakeCoinPrice): CoinUsdPrice | null {
    return usd === null ? null : { usd, at: this.clock.now() - (this.prices.ageMs ?? 0) };
  }
}
