/**
 * Read-only route diagnosis for a Fiber payment A -> Hub -> B (docs/diagnose-route.md).
 *
 * Reads the hub's fnn (node_info, list_channels, graph_nodes for names), optionally the diagnostics JSON that the payer's
 * and payee's browser nodes export (ckbolt-web /app/fiber, Diagnostics, Copy diagnostics), and prints for one amount and
 * asset: the three nodes' versions, each hop's balances and states, whether each hop can carry the amount, the hub's
 * public channels, and hub-side `send_payment` dry runs (keysend). Writes the same as a JSON report.
 *
 * It never pays and never changes a channel: the only methods it calls are in READ_ONLY_METHODS, and send_payment goes
 * out only with `dry_run: true` (checked again right before each request).
 *
 *   npx tsx scripts/diagnose-route.ts --rpc http://127.0.0.1:18227 --payer payer.json --payee payee.json --amount 600
 *   npx tsx scripts/diagnose-route.ts --help
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ASSET_METADATA, TESTNET_RUSD_TYPE_SCRIPT } from "../src/common/constants/assets.constants";
import { authorizationHeaders, buildJsonRpcRequest } from "../src/infrastructure/fiber/fiber-rpc.protocol";

/* ------------------------------------------------------------------------------------------------ constants */

const DEFAULT_RPC_URL = "http://127.0.0.1:18227";
const RPC_TIMEOUT_MS = 20_000;
/** The web app's fee cap for a payment (Pay tab, fnn's default max_fee_rate): 5 per thousand. */
const FEE_PER_THOUSAND = BigInt(5);
const PER_THOUSAND = BigInt(1000);
const DECIMALS = 8;
const GRAPH_PAGE_LIMIT = "0x64";
const GRAPH_MAX_PAGES = 20;
const READY = "ChannelReady";
const REPORT_KIND = "ckbolt-route-diagnosis";
const WEB_DIAGNOSTICS_KIND = "ckbolt-fiber-diagnostics";
/** Every method this script may call. send_payment only ever with dry_run: true (rpcClient refuses anything else). */
const READ_ONLY_METHODS = new Set(["node_info", "list_channels", "graph_nodes", "send_payment"]);

const HELP = `Read-only diagnosis of a Fiber payment A -> Hub -> B.

Options:
  --rpc <url>             hub fnn JSON-RPC (env FIBER_RPC_URL; default ${DEFAULT_RPC_URL}, the SSH tunnel)
  --token <biscuit>       fnn RPC token, if the node needs one (env FIBER_RPC_TOKEN)
  --payer <file>          payer A's diagnostics JSON (web: /app/fiber, Diagnostics, Copy diagnostics)
  --payee <file>          payee B's diagnostics JSON
  --payee-pubkey <hex>    B's node id, when there is no payee file
  --amount <n>            amount in whole units (CKB or the token, 8 decimals), e.g. 600 or 12.5
  --asset <a>             CKB (default), RUSD, a UDT name the hub lists, or code_hash:hash_type:args
  --public-amount <n>     also dry-run a keysend of this amount from the hub to each public channel peer
  --public-target <hex>   a public node to dry-run to (repeatable; default: the hub's public channel peers)
  --include-closed        list the hub's closed channels too
  --no-dry-run            skip every send_payment dry run
  --out <file>            JSON report path (default ./diagnose-route-<time>.json)
  --help`;

/* ------------------------------------------------------------------------------------------------ types */

type Rec = Record<string, unknown>;
/** Without params the request carries `[]`, as fnn wants for node_info; with them `[params]`. */
type Call = (method: string, params?: Rec) => Promise<unknown>;
interface Script {
  codeHash: string;
  hashType: string;
  args: string;
}
interface Asset {
  name: string;
  script: Script | null;
}
interface Channel {
  channelId: string | null;
  peer: string | null;
  state: string | null;
  isPublic: boolean | null;
  enabled: boolean | null;
  script: Script | null;
  local: bigint | null;
  remote: bigint | null;
  offeredTlc: bigint | null;
  receivedTlc: bigint | null;
}
interface WebDiagnostics {
  file: string;
  generatedAt: string | null;
  fiberJsVersion: string | null;
  nodeId: string | null;
  version: string | null;
  channels: Channel[];
  includesClosed: boolean | null;
  routeCheck: unknown;
}
interface DryRun {
  label: string;
  target: string;
  amount: string;
  ok: boolean;
  fee: string | null;
  status: string | null;
  error: string | null;
}
interface HopCheck {
  hop: string;
  side: string;
  channelId: string | null;
  state: string | null;
  isPublic: boolean | null;
  balance: string | null;
  needs: string | null;
  canCarry: boolean | null;
  note: string;
}
type GraphNames = Map<string, { name: string | null; version: string | null }>;

/* ------------------------------------------------------------------------------------------------ helpers */

const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strip0x = (v: string) => (v.startsWith("0x") || v.startsWith("0X") ? v.slice(2) : v);
const nodeId = (v: unknown): string | null => (typeof v === "string" && v.trim() ? strip0x(v.trim()).toLowerCase() : null);
const hex = (n: bigint) => `0x${n.toString(16)}`;
const ZERO = BigInt(0);

/** An fnn quantity (0x hex) or a decimal string as a bigint; null for anything else. */
function big(v: unknown): bigint | null {
  if (typeof v === "string" && /^0x[0-9a-f]+$/i.test(v)) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return null;
}

/** Whole units ("600", "12.5") as base units with 8 decimals. */
function parseWhole(text: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(text.trim());
  if (!m) throw new Error(`Not an amount: ${text}. Use whole units, such as 600 or 12.5.`);
  return BigInt(m[1]!) * BigInt(10) ** BigInt(DECIMALS) + BigInt((m[2] ?? "").padEnd(DECIMALS, "0"));
}

function formatWhole(n: bigint | null): string {
  if (n === null) return "—";
  const unit = BigInt(10) ** BigInt(DECIMALS);
  const frac = (n % unit).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return `${(n / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`;
}

const scriptOf = (v: unknown): Script | null => {
  if (!isRecord(v)) return null;
  const codeHash = str(v.code_hash) ?? str(v.codeHash);
  const hashType = str(v.hash_type) ?? str(v.hashType);
  const args = str(v.args);
  return codeHash && hashType && args !== null ? { codeHash: codeHash.toLowerCase(), hashType, args: args.toLowerCase() } : null;
};
const sameScript = (a: Script | null, b: Script | null) =>
  a === null || b === null ? a === b : a.codeHash.toLowerCase() === b.codeHash.toLowerCase() && a.hashType === b.hashType && a.args.toLowerCase() === b.args.toLowerCase();
const scriptToRpc = (s: Script) => ({ code_hash: s.codeHash, hash_type: s.hashType, args: s.args });
const short = (id: string | null) => (id ? `${id.slice(0, 10)}…${id.slice(-6)}` : "—");
const maxFeeOf = (amount: bigint) => (amount * FEE_PER_THOUSAND) / PER_THOUSAND;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* --------------------------------------------------------------------------------------------- JSON-RPC */

class RpcError extends Error {}

/** JSON-RPC 2.0 over HTTP POST to fnn, framed by the hub's own protocol helpers; refuses anything that is not read-only. */
function rpcClient(url: string, token: string | undefined): Call {
  let id = 1;
  return async (method, params) => {
    if (!READ_ONLY_METHODS.has(method)) throw new Error(`Refusing ${method}: this script only reads.`);
    if (method === "send_payment" && params?.dry_run !== true) throw new Error("Refusing send_payment without dry_run: true.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...authorizationHeaders(token) },
        body: buildJsonRpcRequest(id++, method, params === undefined ? [] : [params]),
        signal: controller.signal,
      });
      if (!response.ok) throw new RpcError(`${method}: HTTP ${response.status}`);
      const body = (await response.json()) as Rec;
      if (isRecord(body.error)) throw new RpcError(String(body.error.message ?? JSON.stringify(body.error)));
      return body.result;
    } catch (e) {
      if (controller.signal.aborted) throw new RpcError(`${method}: no answer within ${RPC_TIMEOUT_MS} ms from ${url}`);
      if (e instanceof RpcError) throw e;
      throw new RpcError(`${method}: cannot reach ${url} (${errorText(e)}). Is the SSH tunnel up?`);
    } finally {
      clearTimeout(timer);
    }
  };
}

/* ----------------------------------------------------------------------------------------------- readers */

const channelFromRpc = (c: Rec): Channel => ({
  channelId: str(c.channel_id),
  peer: nodeId(c.pubkey),
  state: isRecord(c.state) ? str(c.state.state_name) : null,
  isPublic: typeof c.is_public === "boolean" ? c.is_public : null,
  enabled: typeof c.enabled === "boolean" ? c.enabled : null,
  script: scriptOf(c.funding_udt_type_script),
  local: big(c.local_balance),
  remote: big(c.remote_balance),
  offeredTlc: big(c.offered_tlc_balance),
  receivedTlc: big(c.received_tlc_balance),
});

/** A diagnostics JSON exported by the web app's node page (ckbolt-web lib/wallets/fiber-browser/diagnostics.ts, schema 1). */
function readWebDiagnostics(file: string): WebDiagnostics {
  const json = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!isRecord(json) || json.kind !== WEB_DIAGNOSTICS_KIND) throw new Error(`${file} is not a CKBolt diagnostics JSON (kind ${WEB_DIAGNOSTICS_KIND}).`);
  const info = isRecord(json.nodeInfo) ? json.nodeInfo : {};
  const list = isRecord(json.channels) && Array.isArray(json.channels.list) ? json.channels.list.filter(isRecord) : [];
  return {
    file,
    generatedAt: str(json.generatedAt),
    fiberJsVersion: isRecord(json.app) ? str(json.app.fiberJsVersion) : null,
    nodeId: nodeId(info.nodeId),
    version: str(info.version),
    includesClosed: isRecord(json.channels) && typeof json.channels.includesClosed === "boolean" ? json.channels.includesClosed : null,
    routeCheck: json.routeCheck ?? null,
    channels: list.map((c) => {
      const asset = isRecord(c.asset) ? c.asset : {};
      return {
        channelId: str(c.channelId),
        peer: nodeId(c.peerNodeId),
        state: str(c.state),
        isPublic: typeof c.isPublic === "boolean" ? c.isPublic : null,
        enabled: typeof c.enabled === "boolean" ? c.enabled : null,
        script: asset.kind === "UDT" ? scriptOf(asset.script) : null,
        local: big(c.localBalance),
        remote: big(c.remoteBalance),
        offeredTlc: big(c.offeredTlcBalance),
        receivedTlc: big(c.receivedTlcBalance),
      };
    }),
  };
}

/** CKB, RUSD, a UDT the hub's node_info lists by name, or code_hash:hash_type:args. */
function resolveAsset(text: string, hubInfo: Rec): Asset {
  const upper = text.trim().toUpperCase();
  if (upper === "CKB") return { name: "CKB", script: null };
  const parts = text.split(":");
  if (parts.length === 3) return { name: "UDT", script: { codeHash: parts[0]!.toLowerCase(), hashType: parts[1]!, args: parts[2]!.toLowerCase() } };
  const udts = Array.isArray(hubInfo.udt_cfg_infos) ? hubInfo.udt_cfg_infos.filter(isRecord) : [];
  const listed = udts.find((u) => str(u.name)?.toUpperCase() === upper);
  if (listed) return { name: str(listed.name) ?? upper, script: scriptOf(listed.script) };
  if (upper === ASSET_METADATA.RUSD.symbol.toUpperCase()) return { name: "RUSD", script: { ...TESTNET_RUSD_TYPE_SCRIPT } };
  throw new Error(`Unknown asset ${text}. Use CKB, RUSD, a UDT name the hub lists, or code_hash:hash_type:args.`);
}

/** Node names and versions from the hub's gossip graph (bottle, bracer, …); empty when graph_nodes fails. */
async function graphNames(call: Call): Promise<GraphNames> {
  const names: GraphNames = new Map();
  let after: string | undefined;
  for (let page = 0; page < GRAPH_MAX_PAGES; page++) {
    const result = (await call("graph_nodes", { limit: GRAPH_PAGE_LIMIT, ...(after ? { after } : {}) })) as Rec | null;
    const nodes = result && Array.isArray(result.nodes) ? result.nodes.filter(isRecord) : [];
    for (const n of nodes) {
      const id = nodeId(n.pubkey ?? n.node_id);
      if (id) names.set(id, { name: str(n.node_name), version: str(n.version) });
    }
    const next = result ? str(result.last_cursor) : null;
    if (!nodes.length || !next || next === after) break;
    after = next;
  }
  return names;
}

/** send_payment as a keysend dry run: fnn builds the route and its fee and sends nothing. */
async function keysendDryRun(call: Call, label: string, target: string, amount: bigint, asset: Asset): Promise<DryRun> {
  const params: Rec = {
    target_pubkey: target,
    amount: hex(amount),
    keysend: true,
    dry_run: true,
    max_fee_amount: hex(maxFeeOf(amount)),
    ...(asset.script ? { udt_type_script: scriptToRpc(asset.script) } : {}),
  };
  const base = { label, target, amount: amount.toString() };
  try {
    const result = (await call("send_payment", params)) as Rec | null;
    const status = result ? str(result.status) : null;
    return { ...base, ok: status !== "Failed", fee: big(result?.fee)?.toString() ?? null, status, error: result ? str(result.failed_error) : null };
  } catch (e) {
    return { ...base, ok: false, fee: null, status: null, error: errorText(e) };
  }
}

/* ------------------------------------------------------------------------------------------------ output */

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}
const yesNo = (v: boolean | null) => (v === null ? "?" : v ? "yes" : "NO");

/* -------------------------------------------------------------------------------------------------- main */

async function main() {
  const { values } = parseArgs({
    options: {
      rpc: { type: "string" },
      token: { type: "string" },
      payer: { type: "string" },
      payee: { type: "string" },
      "payee-pubkey": { type: "string" },
      amount: { type: "string" },
      asset: { type: "string", default: "CKB" },
      "public-amount": { type: "string" },
      "public-target": { type: "string", multiple: true },
      "include-closed": { type: "boolean", default: false },
      "no-dry-run": { type: "boolean", default: false },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const rpcUrl = values.rpc ?? process.env.FIBER_RPC_URL ?? DEFAULT_RPC_URL;
  const call = rpcClient(rpcUrl, values.token ?? process.env.FIBER_RPC_TOKEN);
  const payer = values.payer ? readWebDiagnostics(values.payer) : null;
  const payee = values.payee ? readWebDiagnostics(values.payee) : null;

  const hubInfo = ((await call("node_info")) ?? {}) as Rec;
  const hubId = nodeId(hubInfo.pubkey);
  const listed = ((await call("list_channels", values["include-closed"] ? { include_closed: true } : {})) ?? {}) as Rec;
  const hubChannels = (Array.isArray(listed.channels) ? listed.channels : []).filter(isRecord).map(channelFromRpc);
  const names = await graphNames(call).catch((): GraphNames => new Map());
  const asset = resolveAsset(values.asset ?? "CKB", hubInfo);
  const amount = values.amount ? parseWhole(values.amount) : null;
  const maxFee = amount === null ? null : maxFeeOf(amount);
  const payeeId = nodeId(values["payee-pubkey"]) ?? payee?.nodeId ?? null;
  const payerId = payer?.nodeId ?? null;
  const ofAsset = (c: Channel) => sameScript(c.script, asset.script);
  const nameOf = (id: string | null) => (id ? (names.get(id)?.name ?? null) : null);
  const notes: string[] = [];

  // Versions of the three nodes.
  const nodes = {
    payer: payer ? { nodeId: payerId, version: payer.version, fiberJs: payer.fiberJsVersion, exportedAt: payer.generatedAt } : null,
    hub: { nodeId: hubId, version: str(hubInfo.version), commitHash: str(hubInfo.commit_hash), nodeName: str(hubInfo.node_name), chainHash: str(hubInfo.chain_hash) },
    payee: payee || payeeId ? { nodeId: payeeId, version: payee?.version ?? null, fiberJs: payee?.fiberJsVersion ?? null, exportedAt: payee?.generatedAt ?? null } : null,
  };
  if (payer?.version && payee?.version && payer.version !== payee.version) notes.push(`A and B run different versions (${payer.version} vs ${payee.version}).`);
  for (const [who, v] of [["A", payer?.version], ["B", payee?.version]] as const) {
    if (v && nodes.hub.version && v !== nodes.hub.version) notes.push(`${who} (${v}) and the hub (${nodes.hub.version}) run different versions.`);
  }

  // Each hop in the paying direction.
  const hops: HopCheck[] = [];
  const needFirst = amount === null || maxFee === null ? null : amount + maxFee;
  const best = (list: Channel[]) => list.find((c) => c.state === READY) ?? list[0];
  const pushHop = (hop: string, side: string, c: Channel | undefined, balance: bigint | null, needs: bigint | null, note: string) =>
    hops.push({
      hop,
      side,
      channelId: c?.channelId ?? null,
      state: c?.state ?? null,
      isPublic: c?.isPublic ?? null,
      balance: balance === null ? null : balance.toString(),
      needs: needs === null ? null : needs.toString(),
      canCarry: !c ? false : needs === null || balance === null ? null : c.state === READY && balance >= needs,
      note: c ? note : `no ${asset.name} channel`,
    });

  if (payer && hubId) {
    const a = best(payer.channels.filter((c) => c.peer === hubId && ofAsset(c)));
    pushHop("A -> Hub", "A's local_balance (A's export)", a, a?.local ?? null, needFirst, "amount + 0.5 % max fee");
  }
  if (payerId) {
    const h = best(hubChannels.filter((c) => c.peer === payerId && ofAsset(c)));
    pushHop("A -> Hub", "hub's remote_balance in A<->Hub", h, h?.remote ?? null, needFirst, "should match A's local_balance");
  }
  if (payeeId) {
    const h = best(hubChannels.filter((c) => c.peer === payeeId && ofAsset(c)));
    pushHop("Hub -> B", "hub's local_balance in Hub<->B", h, h?.local ?? null, amount, "the hub forwards the amount");
    if (h) pushHop("Hub -> B", "hub's remote_balance in Hub<->B", h, h.remote, null, "B's side as the hub sees it");
  }
  if (payee && hubId) {
    const b = best(payee.channels.filter((c) => c.peer === hubId && ofAsset(c)));
    pushHop("Hub -> B", "B's remote_balance (B's export)", b, b?.remote ?? null, amount, "what B can receive");
  }
  if (!payerId) notes.push("No payer file: the A -> Hub hop is not checked.");
  if (!payeeId) notes.push("No payee file or --payee-pubkey: the Hub -> B hop is not checked.");
  if (hops.some((h) => h.isPublic === false)) {
    notes.push("A hop is a private channel: private channels are not in the gossip graph, so a payer's own path search cannot see B (expect \"no path found\") unless it routes through the hub as a trampoline or gets a route hint.");
  }

  // The hub's public channels: what it can send to the public network.
  const ready = hubChannels.filter((c) => c.isPublic && c.state === READY && ofAsset(c));
  const publicLocal = ready.reduce((sum, c) => sum + (c.local ?? ZERO), ZERO);
  const publicMax = ready.reduce((m, c) => ((c.local ?? ZERO) > m ? (c.local ?? ZERO) : m), ZERO);
  const publicChannels = hubChannels
    .filter((c) => c.isPublic)
    .map((c) => ({
      peer: c.peer,
      peerName: nameOf(c.peer),
      peerVersion: c.peer ? (names.get(c.peer)?.version ?? null) : null,
      channelId: c.channelId,
      state: c.state,
      enabled: c.enabled,
      asset: c.script ? (sameScript(c.script, asset.script) ? asset.name : "UDT") : "CKB",
      hubLocal: c.local?.toString() ?? null,
      hubRemote: c.remote?.toString() ?? null,
      offeredTlc: c.offeredTlc?.toString() ?? null,
    }));
  notes.push(
    `The hub can send at most ${formatWhole(publicMax)} ${asset.name} over one public channel (${formatWhole(publicLocal)} over all its ready public ${asset.name} channels). A single-part payment to the public network needs one channel with the amount plus fees on the hub's side, and every hop after it the same.`,
  );

  // Dry runs from the hub.
  const dryRuns: DryRun[] = [];
  if (!values["no-dry-run"]) {
    if (payeeId && amount !== null) dryRuns.push(await keysendDryRun(call, "Hub -> B (keysend)", payeeId, amount, asset));
    const publicAmount = values["public-amount"] ? parseWhole(values["public-amount"]) : null;
    if (publicAmount !== null) {
      const targets = values["public-target"]?.length
        ? values["public-target"].map((t) => nodeId(t)).filter((t): t is string => t !== null)
        : [...new Set(hubChannels.filter((c) => c.isPublic && c.peer).map((c) => c.peer as string))];
      for (const t of targets) dryRuns.push(await keysendDryRun(call, `Hub -> ${nameOf(t) ?? short(t)} (keysend)`, t, publicAmount, asset));
    }
  }

  // The readable part.
  console.log(`\nRoute diagnosis, ${new Date().toISOString()}, hub RPC ${rpcUrl}`);
  console.log(`Amount: ${amount === null ? "(none given)" : `${formatWhole(amount)} ${asset.name}`}${maxFee === null ? "" : `, max fee 0.5 %: ${formatWhole(maxFee)}`}\n`);
  console.log("Nodes");
  console.log(
    table(
      ["role", "node id", "version", "fiber-js", "exported"],
      [
        ["A (payer)", short(nodes.payer?.nodeId ?? null), nodes.payer?.version ?? "—", nodes.payer?.fiberJs ?? "—", nodes.payer?.exportedAt ?? "—"],
        ["Hub", short(hubId), `${nodes.hub.version ?? "?"}${nodes.hub.commitHash ? ` (${nodes.hub.commitHash})` : ""}`, "—", "live"],
        ["B (payee)", short(nodes.payee?.nodeId ?? null), nodes.payee?.version ?? "—", nodes.payee?.fiberJs ?? "—", nodes.payee?.exportedAt ?? "—"],
      ],
    ),
  );
  console.log("\nHops, paying direction A -> Hub -> B");
  console.log(
    table(
      ["hop", "side", "channel", "state", "public", "balance", "needs", "ok", "note"],
      hops.map((h) => [h.hop, h.side, short(h.channelId), h.state ?? "—", yesNo(h.isPublic), formatWhole(big(h.balance)), h.needs ? formatWhole(BigInt(h.needs)) : "", h.needs ? yesNo(h.canCarry) : "", h.note]),
    ),
  );
  console.log("\nHub's public channels");
  console.log(
    table(
      ["peer", "name", "version", "state", "asset", "hub local", "hub remote"],
      publicChannels.map((p) => [short(p.peer), p.peerName ?? "—", p.peerVersion ?? "—", p.state ?? "—", p.asset, formatWhole(big(p.hubLocal)), formatWhole(big(p.hubRemote))]),
    ),
  );
  if (dryRuns.length) {
    console.log("\nDry runs from the hub (send_payment dry_run: true, nothing sent)");
    console.log(table(["route", "amount", "ok", "fee", "error"], dryRuns.map((d) => [d.label, formatWhole(BigInt(d.amount)), yesNo(d.ok), formatWhole(big(d.fee)), d.error ?? ""])));
  }
  for (const [who, d] of [["A", payer], ["B", payee]] as const) {
    if (d?.routeCheck) console.log(`\n${who}'s own route check (from its export):\n${JSON.stringify(d.routeCheck, null, 2)}`);
  }
  console.log("\nNotes");
  for (const n of notes) console.log(`- ${n}`);

  // The JSON report.
  const generatedAt = new Date().toISOString();
  const report = {
    kind: REPORT_KIND,
    schemaVersion: 1,
    generatedAt,
    readOnly: true,
    amount: amount === null ? null : { asset: asset.name, udtTypeScript: asset.script, base: amount.toString(), maxFee: maxFee?.toString() ?? null },
    nodes,
    hubNodeInfo: {
      features: hubInfo.features ?? null,
      addresses: Array.isArray(hubInfo.addresses) ? hubInfo.addresses : [],
      openChannelAutoAcceptMinCkbFundingAmount: big(hubInfo.open_channel_auto_accept_min_ckb_funding_amount)?.toString() ?? null,
      autoAcceptChannelCkbFundingAmount: big(hubInfo.auto_accept_channel_ckb_funding_amount)?.toString() ?? null,
      tlcFeeProportionalMillionths: big(hubInfo.tlc_fee_proportional_millionths)?.toString() ?? null,
      channelCount: big(hubInfo.channel_count)?.toString() ?? null,
      udtCfgInfos: Array.isArray(hubInfo.udt_cfg_infos) ? hubInfo.udt_cfg_infos.filter(isRecord).map((u) => ({ name: str(u.name), script: scriptOf(u.script) })) : [],
    },
    hops,
    hubPublicChannels: publicChannels,
    hubPublicCapacity: { asset: asset.name, largestLocal: publicMax.toString(), totalLocal: publicLocal.toString() },
    dryRuns,
    payerRouteCheck: payer?.routeCheck ?? null,
    payeeRouteCheck: payee?.routeCheck ?? null,
    exports: { payer: payer?.file ?? null, payee: payee?.file ?? null },
    notes,
  };
  const out = values.out ?? `diagnose-route-${generatedAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nReport written to ${out}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof RpcError ? `fnn: ${e.message}` : errorText(e));
  process.exitCode = 1;
});
