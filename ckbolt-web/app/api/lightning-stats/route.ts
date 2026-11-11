import { NextResponse } from "next/server";

// Public Lightning Network statistics from mempool.space: the market CKBolt aims to open to CKB.
// Dynamic with an hour of memory cache (upstream updates about daily). If mempool.space cannot be
// reached, a dated snapshot is returned instead, marked as such, so the page never shows a gap.
export const dynamic = "force-dynamic";

const CACHE_MS = 60 * 60_000;
const SNAPSHOT = {
  nodes: 16_227,
  channels: 32_512,
  capacitySats: 375_373_572_185,
  asOf: "2026-08-30T00:00:00.000Z",
  source: "mempool.space",
  snapshot: true,
};

type Stats = typeof SNAPSHOT;
let cached: { at: number; body: Stats } | null = null;
const FAILURE_CACHE_MS = 5 * 60_000;
let failedAt = 0;

export async function GET() {
  if (cached && Date.now() - cached.at < CACHE_MS) return NextResponse.json(cached.body);
  // After a failure, serve the snapshot for five minutes rather than waiting on the timeout again.
  if (Date.now() - failedAt < FAILURE_CACHE_MS) return NextResponse.json(SNAPSHOT);
  try {
    const res = await fetch("https://mempool.space/api/v1/lightning/statistics/latest", {
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) throw new Error(`mempool ${res.status}`);
    const { latest } = await res.json();
    const body: Stats = {
      nodes: Number(latest?.node_count),
      channels: Number(latest?.channel_count),
      capacitySats: Number(latest?.total_capacity),
      asOf: String(latest?.added),
      source: "mempool.space",
      snapshot: false,
    };
    if (!(body.nodes > 0) || !(body.channels > 0) || !(body.capacitySats > 0)) throw new Error("mempool: bad payload");
    cached = { at: Date.now(), body };
    return NextResponse.json(body);
  } catch {
    failedAt = Date.now();
    return NextResponse.json(SNAPSHOT);
  }
}
