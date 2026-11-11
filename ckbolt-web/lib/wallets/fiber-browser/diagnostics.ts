import type { FiberAssetId, Script } from "@/lib/hub/contract";
import { decodeFiberInvoice, type FiberNetwork } from "@/lib/payment-request";
import { fiberErrorMessage } from "./errors";
import { normalizeNodeId } from "./hex";
import type { BrowserFiberNode, NodeDiagnosticsRaw } from "./node-port";
import { checkInvoiceText, maxFeeOf } from "./payments";
import { sameScript } from "./scripts";

/**
 * Diagnostics of the browser node for Fiber developers (the node page's Diagnostics panel): what node_info and
 * list_channels say, in a JSON anyone can paste into an issue, and optional dry runs of one invoice. A browser node has
 * no RPC anyone outside its tab can reach, so this JSON is how its state leaves the page; the hub's
 * `scripts/diagnose-route.ts` (ckbolt-hub) reads it next to the hub's own node.
 *
 * Nothing secret goes in: fields are copied one by one from a fixed list (never the raw answers), amounts as decimal
 * strings of base units, and no key, preimage, password or invoice text.
 */

export const DIAGNOSTICS_KIND = "ckbolt-fiber-diagnostics";
export const DIAGNOSTICS_SCHEMA_VERSION = 1;

/** A token as the hub lists it, to name a channel's asset. */
export interface KnownAsset {
  id: FiberAssetId;
  udtTypeScript: Script | null;
}

export type DiagnosticsAsset =
  | { kind: "CKB" }
  | { kind: "UDT"; name: string | null; script: Script };

export interface DiagnosticsChannel {
  channelId: string | null;
  peerNodeId: string | null;
  /** The peer is the CKBolt hub's node. */
  withHub: boolean;
  state: string | null;
  stateFlags: string | null;
  isPublic: boolean | null;
  isAcceptor: boolean | null;
  enabled: boolean | null;
  asset: DiagnosticsAsset;
  localBalance: string | null;
  remoteBalance: string | null;
  offeredTlcBalance: string | null;
  receivedTlcBalance: string | null;
  /** Every list_channels field whose name has "reserve" in it (fnn 0.9.1 has none: its balances are net of reserve). */
  reserves: Record<string, string>;
  pendingTlcCount: number | null;
  createdAt: string | null;
  /** createdAt as ISO 8601 (fnn reports milliseconds), or null. */
  createdAtIso: string | null;
  channelOutpoint: string | null;
  tlcExpiryDelta: string | null;
  tlcFeeProportionalMillionths: string | null;
  shutdownTransactionHash: string | null;
  failureDetail: string | null;
}

export interface DiagnosticsUdtCfg {
  name: string | null;
  script: Script | null;
  autoAcceptAmount: string | null;
}

export interface DiagnosticsNodeInfo {
  version: string | null;
  commitHash: string | null;
  nodeId: string | null;
  nodeName: string | null;
  addresses: string[];
  /** As node_info reports them, or null when it reports none (fnn 0.9.1's node_info has no `features`). */
  features: unknown;
  chainHash: string | null;
  autoAccept: {
    openChannelAutoAcceptMinCkbFundingAmount: string | null;
    autoAcceptChannelCkbFundingAmount: string | null;
  };
  tlc: { expiryDelta: string | null; minValue: string | null; feeProportionalMillionths: string | null };
  counts: { channels: string | null; pendingChannels: string | null; peers: string | null };
  udtCfgInfos: DiagnosticsUdtCfg[];
}

export type RouteVia = "direct" | "trampoline";

/**
 * Why the dry run through the hub did not run: the page has no live hub node id on this network (`no_hub_node`: the hub
 * cannot be reached or runs on another network; an id kept from before is never probed), or the invoice is the hub's
 * own (`payee_is_hub`).
 */
export type TrampolineSkip = "no_hub_node" | "payee_is_hub";

export interface RouteCheck {
  via: RouteVia;
  trampolineHops: string[];
  ok: boolean;
  status: string | null;
  /** The fee the dry run found, in base units of the invoice's asset. */
  fee: string | null;
  maxFeeAmount: string | null;
  /** The node's error, readable, and as it came. */
  error: string | null;
  rawError: string | null;
}

export interface RouteCheckReport {
  checkedAt: string;
  dryRun: true;
  /** What the invoice asks for; never the invoice itself. */
  target: {
    network: string | null;
    amount: string | null;
    asset: DiagnosticsAsset | null;
    payee: string | null;
    paymentHash: string | null;
    expiresAt: string | null;
    /** Why parse_invoice failed, when it did; the dry runs still ran. */
    parseError: string | null;
  };
  /** Why no dry run ran (an invoice the page cannot read), or null. */
  error: string | null;
  checks: RouteCheck[];
  /** Why the dry run through the hub did not run; null when it ran, or when no dry run did. */
  trampolineSkipped: TrampolineSkip | null;
}

export interface NodeDiagnostics {
  kind: typeof DIAGNOSTICS_KIND;
  schemaVersion: typeof DIAGNOSTICS_SCHEMA_VERSION;
  generatedAt: string;
  network: string;
  app: { fiberJsVersion: string };
  hubNodeId: string | null;
  nodeInfo: DiagnosticsNodeInfo;
  channels: { includesClosed: boolean; count: number; list: DiagnosticsChannel[] };
  routeCheck: RouteCheckReport | null;
}

export interface DiagnosticsInput {
  raw: NodeDiagnosticsRaw;
  generatedAt: Date;
  network: string;
  fiberJsVersion: string;
  hubNodeId: string | null;
  /** Every id the hub is known by (a channel with one of them is `withHub`). */
  hubNodeIds?: readonly string[];
  assets?: readonly KnownAsset[];
  routeCheck?: RouteCheckReport | null;
}

/* ------------------------------------------------------------------------------------------------ readers */

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const HEX_QUANTITY = /^0x[0-9a-f]+$/i;
const DECIMAL = /^\d+$/;
/** Below this a created_at reads as seconds, above as milliseconds. */
const MS_THRESHOLD = BigInt(100_000_000_000);
const MS_PER_SECOND = BigInt(1000);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** An fnn quantity (0x hex, or already decimal) as a decimal string of base units; null for anything else. */
export function decimalOf(v: unknown): string | null {
  if (typeof v === "bigint") return v >= BigInt(0) ? v.toString() : null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  if (typeof v !== "string") return null;
  if (HEX_QUANTITY.test(v)) return BigInt(v).toString();
  return DECIMAL.test(v) ? v : null;
}

const scriptOf = (v: unknown): Script | null => {
  if (!isRecord(v)) return null;
  const codeHash = str(v.code_hash) ?? str(v.codeHash);
  const hashType = str(v.hash_type) ?? str(v.hashType);
  const args = str(v.args);
  if (!codeHash || !hashType || args === null) return null;
  return { codeHash, hashType: hashType as Script["hashType"], args };
};

/** CKB, or the token with this script, named when the hub lists it. */
export function assetOf(script: Script | null, assets: readonly KnownAsset[] = []): DiagnosticsAsset {
  if (!script) return { kind: "CKB" };
  const known = assets.find((a) => a.udtTypeScript && sameScript(a.udtTypeScript, script));
  return { kind: "UDT", name: known?.id ?? null, script };
}

const isoOfTimestamp = (raw: string | null): string | null => {
  if (raw === null) return null;
  const n = BigInt(raw);
  const ms = n < MS_THRESHOLD ? n * MS_PER_SECOND : n;
  const date = new Date(Number(ms));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const nodeIdOf = (v: unknown): string | null => (typeof v === "string" && v.trim() ? normalizeNodeId(v) : null);

/** Features only as plain data: strings, numbers, booleans, and lists or maps of them. */
function plainFeatures(v: unknown, depth = 0): unknown {
  const MAX_DEPTH = 3;
  if (v === undefined || v === null || depth > MAX_DEPTH) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map((x) => plainFeatures(x, depth + 1));
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plainFeatures(x, depth + 1)]));
  return null;
}

/* ----------------------------------------------------------------------------------------------- builders */

function readNodeInfo(info: Rec): DiagnosticsNodeInfo {
  const udt = Array.isArray(info.udt_cfg_infos) ? info.udt_cfg_infos.filter(isRecord) : [];
  return {
    version: str(info.version),
    commitHash: str(info.commit_hash),
    nodeId: nodeIdOf(info.pubkey),
    nodeName: str(info.node_name),
    addresses: Array.isArray(info.addresses) ? info.addresses.filter((a): a is string => typeof a === "string") : [],
    features: plainFeatures(info.features),
    chainHash: str(info.chain_hash),
    autoAccept: {
      openChannelAutoAcceptMinCkbFundingAmount: decimalOf(info.open_channel_auto_accept_min_ckb_funding_amount),
      autoAcceptChannelCkbFundingAmount: decimalOf(info.auto_accept_channel_ckb_funding_amount),
    },
    tlc: {
      expiryDelta: decimalOf(info.tlc_expiry_delta),
      minValue: decimalOf(info.tlc_min_value),
      feeProportionalMillionths: decimalOf(info.tlc_fee_proportional_millionths),
    },
    counts: {
      channels: decimalOf(info.channel_count),
      pendingChannels: decimalOf(info.pending_channel_count),
      peers: decimalOf(info.peers_count),
    },
    udtCfgInfos: udt.map((u) => ({ name: str(u.name), script: scriptOf(u.script), autoAcceptAmount: decimalOf(u.auto_accept_amount) })),
  };
}

function readChannel(c: Rec, hubIds: ReadonlySet<string>, assets: readonly KnownAsset[]): DiagnosticsChannel {
  const state = isRecord(c.state) ? c.state : {};
  const peer = nodeIdOf(c.pubkey);
  const reserves: Record<string, string> = {};
  for (const [key, value] of Object.entries(c)) {
    const amount = /reserve/i.test(key) ? decimalOf(value) : null;
    if (amount !== null) reserves[key] = amount;
  }
  const createdAt = decimalOf(c.created_at);
  const failure = c.failure_detail;
  return {
    channelId: str(c.channel_id),
    peerNodeId: peer,
    withHub: peer !== null && hubIds.has(peer),
    state: str(state.state_name),
    stateFlags: typeof state.state_flags === "string" ? state.state_flags : state.state_flags === undefined ? null : JSON.stringify(state.state_flags),
    isPublic: bool(c.is_public),
    isAcceptor: bool(c.is_acceptor),
    enabled: bool(c.enabled),
    asset: assetOf(scriptOf(c.funding_udt_type_script), assets),
    localBalance: decimalOf(c.local_balance),
    remoteBalance: decimalOf(c.remote_balance),
    offeredTlcBalance: decimalOf(c.offered_tlc_balance),
    receivedTlcBalance: decimalOf(c.received_tlc_balance),
    reserves,
    pendingTlcCount: Array.isArray(c.pending_tlcs) ? c.pending_tlcs.length : null,
    createdAt,
    createdAtIso: isoOfTimestamp(createdAt),
    channelOutpoint: str(c.channel_outpoint),
    tlcExpiryDelta: decimalOf(c.tlc_expiry_delta),
    tlcFeeProportionalMillionths: decimalOf(c.tlc_fee_proportional_millionths),
    shutdownTransactionHash: str(c.shutdown_transaction_hash),
    failureDetail: typeof failure === "string" ? failure : failure === undefined || failure === null ? null : JSON.stringify(failure),
  };
}

/** The diagnostics JSON's object: safe fields only, amounts as decimal strings. */
export function buildDiagnostics(input: DiagnosticsInput): NodeDiagnostics {
  const hubNodeId = input.hubNodeId ? normalizeNodeId(input.hubNodeId) : null;
  const hubIds = new Set([...(input.hubNodeIds ?? []), ...(hubNodeId ? [hubNodeId] : [])].map(normalizeNodeId));
  const list = input.raw.channels.map((c) => readChannel(c, hubIds, input.assets ?? []));
  return {
    kind: DIAGNOSTICS_KIND,
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt: input.generatedAt.toISOString(),
    network: input.network,
    app: { fiberJsVersion: input.fiberJsVersion },
    hubNodeId,
    nodeInfo: readNodeInfo(input.raw.nodeInfo),
    channels: { includesClosed: input.raw.includesClosed, count: list.length, list },
    routeCheck: input.routeCheck ?? null,
  };
}

const JSON_INDENT = 2;

/** The JSON the Copy diagnostics button copies. */
export const diagnosticsJson = (d: NodeDiagnostics): string => JSON.stringify(d, null, JSON_INDENT);

/* ------------------------------------------------------------------------------------------- route checks */

export interface RouteCheckContext {
  network: FiberNetwork;
  /**
   * The hub's live node id on this network (as Pay uses it), never one kept from before; with it a second dry run goes
   * through the hub as a trampoline hop, without it that dry run is skipped (`no_hub_node`).
   */
  hubNodeId: string | null;
  assets?: readonly KnownAsset[];
  now: Date;
}

type ProbeNode = Pick<BrowserFiberNode, "sendPayment" | "parseInvoice">;

const rawErrorText = (e: unknown): string =>
  typeof e === "string" ? e : e instanceof Error ? e.message : isRecord(e) && typeof e.message === "string" ? e.message : String(e);

async function dryRun(node: ProbeNode, invoice: string, via: RouteVia, hops: string[], maxFee: bigint | undefined): Promise<RouteCheck> {
  const base = { via, trampolineHops: hops, maxFeeAmount: maxFee === undefined ? null : maxFee.toString() };
  try {
    // dryRun is always set: fnn builds the route and its fee, and sends nothing.
    const result = await node.sendPayment(invoice, { dryRun: true, maxFeeAmount: maxFee, ...(hops.length ? { trampolineHops: hops } : {}) });
    const failed = result.status === "Failed";
    return {
      ...base,
      ok: !failed,
      status: result.status,
      fee: result.fee.toString(),
      error: failed ? (result.failedError ?? "Failed") : null,
      rawError: failed ? result.failedError : null,
    };
  } catch (e) {
    return { ...base, ok: false, status: null, fee: null, error: fiberErrorMessage(e), rawError: rawErrorText(e) };
  }
}

/**
 * Dry runs of paying `invoice`: directly, and through the hub as a trampoline hop when its live id is known, each with
 * the Pay tab's fee cap (0.5 % of the amount). Never a real payment, and nothing is written to the node's History.
 */
export async function checkRoute(node: ProbeNode, text: string, ctx: RouteCheckContext): Promise<RouteCheckReport> {
  const report: RouteCheckReport = {
    checkedAt: ctx.now.toISOString(),
    dryRun: true,
    target: { network: null, amount: null, asset: null, payee: null, paymentHash: null, expiresAt: null, parseError: null },
    error: null,
    checks: [],
    trampolineSkipped: null,
  };
  const checked = checkInvoiceText(text, ctx.network);
  if (checked.status !== "ok") {
    report.error = checked.status === "empty" ? "Paste a Fiber invoice." : checked.error;
    return report;
  }
  const invoice = checked.invoice;
  const decoded = decodeFiberInvoice(invoice);
  report.target.network = decoded.network;
  report.target.amount = decoded.amount === null ? null : decoded.amount.toString();
  try {
    const parsed = await node.parseInvoice(invoice);
    report.target.asset = assetOf(parsed.udtTypeScript, ctx.assets);
    report.target.payee = parsed.payee;
    report.target.paymentHash = parsed.paymentHash;
    report.target.expiresAt = parsed.expiresAtMs === null ? null : new Date(parsed.expiresAtMs).toISOString();
  } catch (e) {
    report.target.parseError = fiberErrorMessage(e);
  }
  const maxFee = decoded.amount === null ? undefined : maxFeeOf(decoded.amount);
  report.checks.push(await dryRun(node, invoice, "direct", [], maxFee));
  const hub = ctx.hubNodeId ? normalizeNodeId(ctx.hubNodeId) : null;
  if (!hub) report.trampolineSkipped = "no_hub_node";
  else if (report.target.payee === hub) report.trampolineSkipped = "payee_is_hub";
  else report.checks.push(await dryRun(node, invoice, "trampoline", [hub], maxFee));
  return report;
}
