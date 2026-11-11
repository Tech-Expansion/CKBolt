import { NextResponse } from "next/server";
import type { RateSnapshot } from "@/lib/quote";

// Server-side proxy so the browser makes one same-origin call, upstream rate
// limits are shared, and a real liquidity-provider quote API can replace this later
// Dynamic, with a 20-second memory cache: Next's page cache could hand out an old price
// after a quiet period ("stale while revalidate"), which a quote must never use.
export const dynamic = "force-dynamic";
const CACHE_MS = 20_000;
let cached: { at: number; body: RateSnapshot } | null = null;
// When every source fails, say so quickly for a few seconds instead of retrying all three each time.
const FAILURE_CACHE_MS = 10_000;
let failedAt = 0;
// A source whose price is older than this is skipped in favour of the next one.
const MAX_SOURCE_AGE_MS = 10 * 60_000;

// A slow source falls through to the next one instead of hanging the request.
const UPSTREAM_TIMEOUT_MS = 5_000;

async function fromCoinGecko(): Promise<RateSnapshot> {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,nervos-network&vs_currencies=usd&include_last_updated_at=true",
    { cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`coingecko ${res.status}`);
  const j = await res.json();
  const btcUsd = j?.bitcoin?.usd;
  const ethUsd = j?.ethereum?.usd;
  const ckbUsd = j?.["nervos-network"]?.usd;
  if (!(btcUsd > 0) || !(ethUsd > 0) || !(ckbUsd > 0)) throw new Error("coingecko: bad payload");
  const ts = Math.min(
    j.bitcoin.last_updated_at ?? Infinity,
    j.ethereum.last_updated_at ?? Infinity,
    j["nervos-network"].last_updated_at ?? Infinity,
  );
  return {
    btcUsd,
    ethUsd,
    ckbUsd,
    source: "CoinGecko",
    updatedAt: Number.isFinite(ts) ? ts * 1000 : Date.now(),
  };
}

async function fromBinance(): Promise<RateSnapshot> {
  const get = async (symbol: string) => {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`binance ${r.status}`);
    return Number((await r.json()).price);
  };
  const [btcUsd, ethUsd, ckbUsd] = await Promise.all([get("BTCUSDT"), get("ETHUSDT"), get("CKBUSDT")]);
  if (!(btcUsd > 0) || !(ethUsd > 0) || !(ckbUsd > 0)) throw new Error("binance: bad payload");
  return { btcUsd, ethUsd, ckbUsd, source: "Binance spot (USDT)", updatedAt: Date.now() };
}

// Binance answers HTTP 451 to US-hosted servers, so KuCoin is a third source.
async function fromKuCoin(): Promise<RateSnapshot> {
  const get = async (symbol: string) => {
    const r = await fetch(`https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${symbol}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`kucoin ${r.status}`);
    return Number((await r.json())?.data?.price);
  };
  const [btcUsd, ethUsd, ckbUsd] = await Promise.all([get("BTC-USDT"), get("ETH-USDT"), get("CKB-USDT")]);
  if (!(btcUsd > 0) || !(ethUsd > 0) || !(ckbUsd > 0)) throw new Error("kucoin: bad payload");
  return { btcUsd, ethUsd, ckbUsd, source: "KuCoin spot (USDT)", updatedAt: Date.now() };
}

export async function GET() {
  if (cached && Date.now() - cached.at < CACHE_MS) return NextResponse.json(cached.body);
  if (Date.now() - failedAt < FAILURE_CACHE_MS) {
    return NextResponse.json({ error: "Market rate is temporarily unavailable." }, { status: 503 });
  }
  for (const source of [fromCoinGecko, fromBinance, fromKuCoin]) {
    try {
      const body = await source();
      if (Date.now() - body.updatedAt > MAX_SOURCE_AGE_MS) throw new Error("stale");
      cached = { at: Date.now(), body };
      return NextResponse.json(body);
    } catch {
      // try the next source
    }
  }
  failedAt = Date.now();
  return NextResponse.json({ error: "Market rate is temporarily unavailable." }, { status: 503 });
}
