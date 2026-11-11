import { randomBytes, randomUUID } from "node:crypto";
import type { BrowserContext, Page, Route } from "@playwright/test";
import { CHARSET, hrpExpand, polymod, toWords } from "../../../lib/bech32";
import { encodeUnsignedBolt11, type Network } from "../../../lib/bolt11";
import { demoFiberInvoice } from "../../../lib/payment-request";
import {
  SWAP_CANCEL_TOKEN_HEADER,
  SWAP_EVENT,
  type AssetDto,
  type CreateQuoteBody,
  type CreateSwapBody,
  type CreatedSwapDto,
  type Direction,
  type FiberAssetId,
  type HealthDto,
  type LegDto,
  type QuoteDto,
  type SwapDto,
  type SwapEventDto,
} from "../../../lib/hub/contract";

/*
 * A stand-in for the CKBolt hub's REST API v1 (lib/hub/contract.ts) for Playwright: every /api/hub/** call of a page or
 * browser context is answered here, so no test reaches a real hub, even on a server whose HUB_URL is set. One swap at a
 * time, moved along by the test with advance(); every request is recorded; fail() makes a route answer an error.
 * As the hub does: a quote with `purpose: "request"` lives `requestQuoteTtlMs` (ln_to_fiber only, 422
 * purpose_unsupported otherwise), POST /v1/swaps answers the swap's cancel token once, and POST /v1/swaps/:id/cancel
 * with that token (X-CKBolt-Cancel-Token) cancels a swap nobody paid.
 */

/** Reference prices for /api/rate: 1 BTC = 40,000,000 CKB. */
export const RATE = { btcUsd: 80_000, ethUsd: 2_500, ckbUsd: 0.002, source: "Test fixture", updatedAt: Date.now() };

/**
 * Prices in micro-USD per whole unit, so the fake's amounts are exact. cWBTC is quoted 1:1 with BTC (the hub's
 * `btc_parity` rule): with 8 decimals, one base unit is one sat.
 */
const MICRO_USD: Record<string, bigint> = { BTC: BigInt(80_000_000_000), CKB: BigInt(2_000), RUSD: BigInt(1_000_000), CWBTC: BigInt(80_000_000_000) };
const USD: Record<string, number> = { CKB: 0.002, RUSD: 1, CWBTC: 80_000 };
/** What the hub's GET /v1/assets names each asset (its ASSET_METADATA and FIBER_ASSETS on testnet). */
const ASSET_NAMES: Record<string, { symbol: string; name: string }> = {
  CKB: { symbol: "CKB", name: "Nervos CKB" },
  RUSD: { symbol: "RUSD", name: "RUSD stablecoin" },
  CWBTC: { symbol: "cWBTC", name: "CCH Wrapped BTC" },
};
export const FEE_BPS = 100;
const SATS_PER_BTC = BigInt(100_000_000);
const BPS = BigInt(10_000);
export const HUB_PUBKEY = "02" + "c0ffee".repeat(10) + "abcd";
export const BOTH: Direction[] = ["ln_to_fiber", "fiber_to_ln"];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Mutinynet's tip on 2026-10-23: the hub's Lightning block height in HEALTHY. */
export const HUB_HEIGHT = 3_528_733;
/** The hub's quotes hold this long by default. */
const QUOTE_TTL_MS = 150_000;
/** A request quote (Get paid's Lightning invoice) holds this long: the hub's REQUEST_QUOTE_TTL_SECONDS default. */
const REQUEST_QUOTE_TTL_MS = 900_000;
/** The hub's failure reason for a swap cancelled with its token. */
export const CANCELLED_ON_REQUEST_REASON = "Cancelled by its creator before anyone paid.";
/** Seconds the fake's hold invoices stay payable (the quote's lifetime). */
const HOLD_INVOICE_EXPIRY_SECONDS = 150;

export const hubAsset = (id: FiberAssetId, directions: Direction[] = BOTH, overrides: Partial<AssetDto> = {}): AssetDto => ({
  id,
  symbol: ASSET_NAMES[id]?.symbol ?? id,
  name: ASSET_NAMES[id]?.name ?? id,
  // The hub's FIBER_ASSETS display fields, null unless a test sets them.
  displayName: null,
  iconUrl: null,
  decimals: 8,
  directions,
  minSats: "1000",
  maxSats: "100000",
  liquidity: { lightningSats: "5000000", fiberAmount: "100000000000000" },
  ...overrides,
});

export const HEALTHY: HealthDto = {
  status: "ok",
  version: "0.1.0",
  lightning: { reachable: true, network: "signet", synced: true, blockHeight: HUB_HEIGHT },
  fiber: { reachable: true, network: "testnet", version: "0.9.1" },
  demo: { enabled: true },
  swaps: { paused: false },
};

/** An error body in the contract's shape. */
export const apiError = (code: string, message: string) => ({ error: { code, message } });

/** An unsigned BOLT11 invoice that decodes like a real one; `timestamp` (Unix seconds) makes an old one. */
export const lightningInvoice = (o: { sats: number; network?: Network; hash?: Buffer; expirySeconds?: number; description?: string; timestamp?: number }) =>
  encodeUnsignedBolt11({
    network: o.network ?? "signet",
    amountSats: o.sats,
    paymentHash: o.hash ?? randomBytes(32),
    description: o.description ?? "CKBolt",
    expirySeconds: o.expirySeconds ?? 600,
    timestamp: o.timestamp,
  });

const BOLT11_HRP: Record<Network, string> = { mainnet: "lnbc", testnet: "lntb", signet: "lntbs", regtest: "lnbcrt" };

/** Big-endian base-32 words of an integer, at least `len` long. */
function intWords(n: number, len = 1): number[] {
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 32)) out.unshift(v % 32);
  while (out.length < len) out.unshift(0);
  return out;
}

/**
 * A BOLT11 string with any human-readable part, so any amount or none (`hrp: "lntbs"`), and an optional payment hash,
 * which `encodeUnsignedBolt11` cannot make. Unsigned, like every invoice of the fakes.
 */
export function rawLightningInvoice(o: { hrp: string; hash?: Buffer | null; expirySeconds?: number; timestamp?: number }): string {
  const tagged = (tag: string, words: number[]) => [CHARSET.indexOf(tag), ...intWords(words.length, 2), ...words];
  const data = [...intWords(o.timestamp ?? Math.floor(Date.now() / 1000), 7)];
  if (o.hash !== null) data.push(...tagged("p", toWords(o.hash ?? randomBytes(32))));
  data.push(...tagged("d", toWords(new TextEncoder().encode("CKBolt"))));
  data.push(...tagged("x", intWords(o.expirySeconds ?? 3_600)));
  data.push(...new Array<number>(104).fill(0));
  const chk = polymod([...hrpExpand(o.hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (chk >>> (5 * (5 - i))) & 31);
  return `${o.hrp}1${[...data, ...checksum].map((w) => CHARSET[w]).join("")}`;
}

/** A Lightning invoice without an amount, as some wallets make by default: the hub refuses it. */
export const amountlessInvoice = (network: Network = "signet") => rawLightningInvoice({ hrp: BOLT11_HRP[network] });

/** What a failing route answers: a status and JSON body, raw text, or a dropped connection; `times` limits it. */
export type Fault = { status?: number; body?: unknown; raw?: string; abort?: boolean; times?: number };

export class FakeHub {
  health: HealthDto = structuredClone(HEALTHY);
  healthStatus = 200;
  assets: AssetDto[] = [hubAsset("CKB"), hubAsset("RUSD")];
  quoteTtlMs = QUOTE_TTL_MS;
  requestQuoteTtlMs = REQUEST_QUOTE_TTL_MS;
  /** How far the page's fake clock has been moved ahead, so hub times agree with the page's. */
  skewMs = 0;
  /** Replaces the hold invoice of the next swap: a hub that hands out an invoice that is not the swap's. */
  holdInvoice: ((swap: SwapDto) => string) | null = null;

  /** Every request as "METHOD /v1/path", with ids as :id. */
  readonly requests: string[] = [];
  readonly quoteBodies: CreateQuoteBody[] = [];
  readonly quotes: QuoteDto[] = [];
  readonly swapBodies: CreateSwapBody[] = [];
  /** Each swap's cancel token, by swap id, as POST /v1/swaps answered it. */
  readonly cancelTokens = new Map<string, string>();
  /** Every POST /v1/swaps/:id/cancel: the swap id, the token header it carried (or null), and the status answered. */
  readonly cancels: { id: string; token: string | null; status: number }[] = [];
  /** Swaps the test is not following any more ("New invoice" made another), by id, for their cancel. */
  private readonly earlier = new Map<string, SwapDto>();
  swap: SwapDto | null = null;
  events: SwapEventDto[] = [];
  private readonly faults = new Map<string, Fault>();
  /** Extra time some routes take to answer, by "METHOD /v1/path". */
  readonly latencyMs = new Map<string, number>();

  now = () => Date.now() + this.skewMs;
  iso = (ms = this.now()) => new Date(ms).toISOString();

  async install(target: Page | BrowserContext) {
    await target.route("**/api/hub/**", (route) => this.handle(route));
  }

  count(key: string): number {
    return this.requests.filter((r) => r === key).length;
  }

  fail(key: string, fault: Fault) {
    this.faults.set(key, fault);
  }

  heal(key: string) {
    this.faults.delete(key);
  }

  get lastQuote(): QuoteDto {
    return this.quotes.at(-1)!;
  }

  /** Moves the swap to a new state, as the hub's engine would, and logs events. */
  advance(patch: Partial<Pick<SwapDto, "state" | "refunded" | "failureReason" | "preimage">>, ...events: [string, string][]) {
    if (!this.swap) throw new Error("no swap to advance");
    this.swap = { ...this.swap, ...patch, updatedAt: this.iso() };
    for (const [type, detail] of events) this.events.push({ at: this.iso(), type, detail });
  }

  private async handle(route: Route) {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/hub/, "");
    const key = `${request.method()} ${path.replace(UUID, ":id")}`;
    this.requests.push(key);
    const body = request.postDataJSON?.() ?? null;
    const latency = this.latencyMs.get(key);
    if (latency) await new Promise((resolve) => setTimeout(resolve, latency));

    const fault = this.faults.get(key);
    if (fault) {
      if (fault.times !== undefined && --fault.times <= 0) this.faults.delete(key);
      if (fault.abort) return route.abort("connectionrefused");
      if (fault.raw !== undefined) return route.fulfill({ status: fault.status ?? 500, contentType: "text/html", body: fault.raw });
      return route.fulfill({ status: fault.status ?? 500, json: fault.body });
    }

    switch (key) {
      case "GET /v1/health":
        return route.fulfill({ status: this.healthStatus, json: this.health });
      case "GET /v1/assets":
        return route.fulfill({ json: { data: this.assets } });
      case "POST /v1/quotes": {
        this.quoteBodies.push(body);
        if (body?.purpose === "request" && body.direction !== "ln_to_fiber") {
          return route.fulfill({ status: 422, json: apiError("purpose_unsupported", "The hub makes request quotes for ln_to_fiber only.") });
        }
        const quote = this.makeQuote(body);
        this.quotes.push(quote);
        return route.fulfill({ status: 201, json: quote, headers: { location: `/api/hub/v1/quotes/${quote.id}` } });
      }
      case "GET /v1/quotes/:id":
        return route.fulfill({ json: this.quotes.find((q) => path.endsWith(q.id)) });
      case "POST /v1/swaps": {
        this.swapBodies.push(body);
        if (this.swap) this.earlier.set(this.swap.id, this.swap);
        this.swap = this.makeSwap(body);
        this.events = [{ at: this.iso(), type: "created", detail: "Swap created; waiting for your payment." }];
        const cancelToken = randomBytes(32).toString("hex");
        this.cancelTokens.set(this.swap.id, cancelToken);
        const created: CreatedSwapDto = { ...this.swap, cancelToken };
        return route.fulfill({ status: 201, json: created, headers: { location: `/api/hub/v1/swaps/${this.swap.id}` } });
      }
      case "POST /v1/swaps/:id/cancel":
        return this.cancelRoute(route, path.split("/")[3], request.headers()[SWAP_CANCEL_TOKEN_HEADER] ?? null);
      case "GET /v1/swaps/:id":
        return this.swap && path.endsWith(this.swap.id)
          ? route.fulfill({ json: this.swap })
          : route.fulfill({ status: 404, json: apiError("not_found", "No swap with this id.") });
      case "GET /v1/swaps/:id/events":
        return route.fulfill({ json: { data: this.events } });
      default:
        // The demo wallet routes (/v1/demo/*) included: the app's UI never calls them; `count` shows if it did.
        return route.fulfill({ status: 404, json: apiError("not_found", "This is not a CKBolt hub API path.") });
    }
  }

  /**
   * POST /v1/swaps/:id/cancel as the hub answers it: 403 cancel_refused without the swap's own token; a swap nobody paid
   * (pending) fails, cancelled on request with its hold invoice; asking again answers the same; 409 once a payment
   * arrived or the swap ended otherwise.
   */
  private cancelRoute(route: Route, id: string, token: string | null) {
    const current = this.swap?.id === id ? this.swap : (this.earlier.get(id) ?? null);
    const answer = (status: number, json: unknown) => {
      this.cancels.push({ id, token, status });
      return route.fulfill({ status, json });
    };
    if (!current) return answer(404, apiError("not_found", "Swap was not found."));
    if (!token || token !== this.cancelTokens.get(id)) return answer(403, apiError("cancel_refused", "This request does not carry the swap's cancel token."));
    if (current.state === "failed" && current.failureReason === CANCELLED_ON_REQUEST_REASON) return answer(200, current);
    if (current.state !== "pending") return answer(409, apiError("conflict", "A payment arrived, or the swap has moved on: it cannot be cancelled."));
    const cancelled: SwapDto = { ...current, state: "failed", refunded: true, failureReason: CANCELLED_ON_REQUEST_REASON, updatedAt: this.iso() };
    if (this.swap?.id === id) {
      this.swap = cancelled;
      this.events.push({ at: this.iso(), type: SWAP_EVENT.CANCELLED_ON_REQUEST, detail: CANCELLED_ON_REQUEST_REASON });
    } else this.earlier.set(id, cancelled);
    return answer(200, cancelled);
  }

  /**
   * Prices a quote as the hub does: `side: "pay"` fixes what the user pays and rounds what they receive down;
   * `side: "receive"` fixes what they receive (exact out, a pasted invoice's amount) and rounds what they pay up.
   */
  private makeQuote(body: CreateQuoteBody): QuoteDto {
    const asset = this.assets.find((a) => a.id === body.asset)!;
    const scale = BigInt(`1${"0".repeat(asset.decimals)}`);
    const amount = BigInt(body.amount);
    const keep = BigInt(10_000 - FEE_BPS);
    const ceilDiv = (a: bigint, b: bigint) => (a + b - BigInt(1)) / b;
    const btcLeg = (sats: bigint): LegDto => ({ network: "lightning", asset: "BTC", amount: sats.toString(), decimals: 8 });
    const fiberLeg = (units: bigint): LegDto => ({ network: "fiber", asset: body.asset, amount: units.toString(), decimals: asset.decimals });
    // What a paid amount buys, either way, after the fee (rounded down, in the hub's favour).
    const unitsForSats = (sats: bigint) => (sats * MICRO_USD.BTC * scale * keep) / (SATS_PER_BTC * MICRO_USD[body.asset] * BPS);
    const satsForUnits = (units: bigint) => (units * MICRO_USD[body.asset] * SATS_PER_BTC * keep) / (scale * MICRO_USD.BTC * BPS);
    const legs =
      body.direction === "fiber_to_ln"
        ? body.side === "receive"
          ? { pay: fiberLeg(ceilDiv(amount * scale * MICRO_USD.BTC * BPS, MICRO_USD[body.asset] * SATS_PER_BTC * keep)), receive: btcLeg(amount) }
          : { pay: fiberLeg(amount), receive: btcLeg(satsForUnits(amount)) }
        : body.side === "receive"
          ? { pay: btcLeg(ceilDiv(amount * MICRO_USD[body.asset] * SATS_PER_BTC * BPS, scale * MICRO_USD.BTC * keep)), receive: fiberLeg(amount) }
          : { pay: btcLeg(amount), receive: fiberLeg(unitsForSats(amount)) };
    const now = this.now();
    return {
      id: randomUUID(),
      direction: body.direction,
      asset: body.asset,
      ...legs,
      prices: { btcUsd: 80_000, assetUsd: USD[body.asset], source: "median of 3 exchanges", at: this.iso(now) },
      feeBps: FEE_BPS,
      purpose: body.purpose ?? "swap",
      createdAt: this.iso(now),
      expiresAt: this.iso(now + (body.purpose === "request" ? this.requestQuoteTtlMs : this.quoteTtlMs)),
      signature: "3044" + randomBytes(34).toString("hex"),
      hubPubkey: HUB_PUBKEY,
    };
  }

  private makeSwap(body: CreateSwapBody): SwapDto {
    const quote = this.quotes.find((q) => q.id === body.quoteId)!;
    const id = randomUUID();
    const hash = randomBytes(32);
    const network = (this.health.lightning.network ?? "signet") as Network;
    const hold =
      quote.pay.network === "lightning"
        ? lightningInvoice({ sats: Number(quote.pay.amount), network, hash, expirySeconds: HOLD_INVOICE_EXPIRY_SECONDS, description: "CKBolt hold invoice" })
        : demoFiberInvoice("testnet", BigInt(quote.pay.amount));
    const swap: SwapDto = {
      id,
      quoteId: quote.id,
      direction: quote.direction,
      asset: quote.asset,
      state: "pending",
      paymentHash: hash.toString("hex"),
      pay: { ...quote.pay, invoice: hold },
      receive: { ...quote.receive, invoice: body.payoutInvoice },
      refunded: false,
      failureReason: null,
      preimage: null,
      demo: body.demo ?? false,
      quoteExpiresAt: quote.expiresAt,
      createdAt: this.iso(),
      updatedAt: this.iso(),
      links: { self: `/v1/swaps/${id}`, events: `/v1/swaps/${id}/events` },
    };
    if (this.holdInvoice) swap.pay = { ...swap.pay, invoice: this.holdInvoice(swap) };
    return swap;
  }
}

/** A server without a hub: every /api/hub/** call answers 503 hub_unavailable, as the proxy does without HUB_URL. */
export async function installNoHub(target: Page | BrowserContext) {
  await target.route("**/api/hub/**", (route) =>
    route.fulfill({ status: 503, json: apiError("hub_unavailable", "Live swaps are not set up on this server."), headers: { "cache-control": "no-store" } }),
  );
}

/** Moves the page's fake clock (page.clock.install) and the hub's clock together. */
export async function fastForward(page: Page, hub: FakeHub, ms: number) {
  hub.skewMs += ms;
  await page.clock.fastForward(ms);
}

/** How far ahead of the page's time a clock pause lands, so it never falls in the page clock's past on a slow machine. */
const CLOCK_PAUSE_LEAD_MS = 5_000;

/**
 * Stops the page's fake clock a little ahead of its current time, which `hub.now()` tracks. From then on page timers
 * run only when the test fast-forwards; `page.clock.resume()` lets it run in real time again.
 */
export async function pauseClock(page: Page, hub: FakeHub) {
  hub.skewMs += CLOCK_PAUSE_LEAD_MS;
  await page.clock.pauseAt(hub.now());
}
