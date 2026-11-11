import { expect, test } from "@playwright/test";
import { demoFiberInvoice } from "../../lib/payment-request";
import {
  buildDiagnostics,
  checkRoute,
  decimalOf,
  diagnosticsJson,
  DIAGNOSTICS_KIND,
  type KnownAsset,
  type RouteCheckReport,
} from "../../lib/wallets/fiber-browser/diagnostics";
import { FiberJsNode, type FiberLike } from "../../lib/wallets/fiber-browser/fiber-js-adapter";
import type { NodeDiagnosticsRaw, NodePayment, ParsedInvoice, SendPaymentOptions } from "../../lib/wallets/fiber-browser/node-port";

/*
 * The node page's diagnostics (lib/wallets/fiber-browser/diagnostics.ts): the JSON a Fiber developer asks for (shape,
 * decimal strings, nothing secret), the route dry runs, and the adapter's send_payment and list_channels parameters.
 */

const HUB = "02b6d4e3ab86a2ca2fad6fae0ecb2e1e559e0b911939872a90abdda6d20302be71";
const NODE = "03" + "ab".repeat(32);
const OTHER = "02" + "cd".repeat(32);
const RUSD = { codeHash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a", hashType: "type", args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b" } as const;
const RUSD_RPC = { code_hash: RUSD.codeHash, hash_type: RUSD.hashType, args: RUSD.args };
const ASSETS: KnownAsset[] = [
  { id: "CKB", udtTypeScript: null },
  { id: "RUSD", udtTypeScript: RUSD },
];
const SECRET = "deadbeef".repeat(8);
const SECRET_KEYS = /secret|private|preimage|password|mnemonic|seed|keystore|invoice_address/i;

/** node_info and list_channels as fnn 0.9.1 answers, with fields that must never be copied mixed in. */
const RAW: NodeDiagnosticsRaw = {
  includesClosed: true,
  nodeInfo: {
    version: "0.9.1",
    commit_hash: "abc1234",
    pubkey: NODE.toUpperCase(),
    node_name: "browser",
    addresses: ["/ip4/127.0.0.1/tcp/8228/ws"],
    chain_hash: "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606",
    open_channel_auto_accept_min_ckb_funding_amount: "0x9502f9000",
    auto_accept_channel_ckb_funding_amount: "0x24e160300",
    default_funding_lock_script: { code_hash: "0x9bd7", hash_type: "type", args: "0x01" },
    tlc_expiry_delta: "0xdbba00",
    tlc_min_value: "0x0",
    tlc_fee_proportional_millionths: "0x3e8",
    channel_count: "0x3",
    pending_channel_count: "0x1",
    peers_count: "0x2",
    udt_cfg_infos: [{ name: "RUSD", script: RUSD_RPC, auto_accept_amount: "0x3b9aca00", cell_deps: [] }],
    private_key: SECRET,
  },
  channels: [
    {
      channel_id: "0x" + "11".repeat(32),
      is_public: false,
      is_acceptor: true,
      channel_outpoint: "0x" + "22".repeat(36),
      pubkey: HUB,
      state: { state_name: "ChannelReady", state_flags: "0x0" },
      local_balance: "0x174876e800",
      remote_balance: "0x2540be400",
      offered_tlc_balance: "0x0",
      received_tlc_balance: "0x5f5e100",
      local_reserved_ckb_amount: "0x24e160300",
      created_at: "0x19a3c4d5e00",
      enabled: true,
      tlc_expiry_delta: "0xdbba00",
      tlc_fee_proportional_millionths: "0x3e8",
      pending_tlcs: [{ id: "0x1", amount: "0x5f5e100", payment_hash: "0x" + "33".repeat(32), payment_preimage: SECRET }],
    },
    {
      channel_id: "0x" + "44".repeat(32),
      is_public: true,
      pubkey: OTHER,
      funding_udt_type_script: RUSD_RPC,
      state: { state_name: "Closed", state_flags: ["COOPERATIVE"] },
      local_balance: "0x0",
      remote_balance: "0x77359400",
      created_at: "0x6720f000",
      enabled: false,
      shutdown_transaction_hash: "0x" + "55".repeat(32),
      payment_preimage: SECRET,
    },
  ],
};

const allKeys = (value: unknown, out: string[] = []): string[] => {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allKeys(v, out);
    }
  return out;
};

const build = (routeCheck: RouteCheckReport | null = null) =>
  buildDiagnostics({
    raw: RAW,
    generatedAt: new Date("2026-11-05T10:00:00Z"),
    network: "testnet",
    fiberJsVersion: "0.9.1",
    hubNodeId: "0x" + HUB.toUpperCase(),
    hubNodeIds: [HUB],
    assets: ASSETS,
    routeCheck,
  });

test.describe("diagnostics JSON", () => {
  test("has the node's version, settings and every channel, amounts as decimal strings of base units", () => {
    const d = build();
    expect(d.kind).toBe(DIAGNOSTICS_KIND);
    expect(d.schemaVersion).toBe(1);
    expect(d.generatedAt).toBe("2026-11-05T10:00:00.000Z");
    expect(d.network).toBe("testnet");
    expect(d.app).toEqual({ fiberJsVersion: "0.9.1" });
    expect(d.hubNodeId).toBe(HUB);
    expect(d.nodeInfo).toMatchObject({
      version: "0.9.1",
      commitHash: "abc1234",
      nodeId: NODE,
      chainHash: RAW.nodeInfo.chain_hash,
      features: null,
      autoAccept: { openChannelAutoAcceptMinCkbFundingAmount: "40000000000", autoAcceptChannelCkbFundingAmount: "9900000000" },
      tlc: { expiryDelta: "14400000", minValue: "0", feeProportionalMillionths: "1000" },
      counts: { channels: "3", pendingChannels: "1", peers: "2" },
      udtCfgInfos: [{ name: "RUSD", script: RUSD, autoAcceptAmount: "1000000000" }],
    });
    expect(d.channels.includesClosed).toBe(true);
    expect(d.channels.count).toBe(2);
    const [hub, closed] = d.channels.list;
    expect(hub).toMatchObject({
      peerNodeId: HUB,
      withHub: true,
      state: "ChannelReady",
      isPublic: false,
      isAcceptor: true,
      enabled: true,
      asset: { kind: "CKB" },
      localBalance: "100000000000",
      remoteBalance: "10000000000",
      offeredTlcBalance: "0",
      receivedTlcBalance: "100000000",
      reserves: { local_reserved_ckb_amount: "9900000000" },
      pendingTlcCount: 1,
      createdAt: String(0x19a3c4d5e00),
      createdAtIso: new Date(0x19a3c4d5e00).toISOString(),
    });
    expect(closed).toMatchObject({
      withHub: false,
      state: "Closed",
      stateFlags: '["COOPERATIVE"]',
      isPublic: true,
      isAcceptor: null,
      asset: { kind: "UDT", name: "RUSD", script: RUSD },
      localBalance: "0",
      remoteBalance: "2000000000",
      offeredTlcBalance: null,
      reserves: {},
      // created_at in seconds still reads as a date.
      createdAtIso: new Date(0x6720f000 * 1000).toISOString(),
    });
    for (const c of d.channels.list) {
      for (const field of ["localBalance", "remoteBalance"] as const) expect(c[field]).toMatch(/^\d+$/);
    }
  });

  test("carries nothing secret: no key, preimage, password or invoice field, and no secret value", () => {
    const json = diagnosticsJson(build());
    expect(allKeys(JSON.parse(json)).filter((k) => SECRET_KEYS.test(k))).toEqual([]);
    expect(json).not.toContain(SECRET);
    // The node's lock is its address, not a secret, but nobody asked for it: it stays out.
    expect(json).not.toContain("default_funding_lock_script");
    expect(json).not.toContain("defaultFundingLockScript");
  });

  test("decimalOf reads 0x quantities and decimal strings, and nothing else", () => {
    expect(decimalOf("0x0")).toBe("0");
    expect(decimalOf("0xffffffffffffffffffffffffffffffff")).toBe("340282366920938463463374607431768211455");
    expect(decimalOf("12345")).toBe("12345");
    expect(decimalOf(BigInt(7))).toBe("7");
    expect(decimalOf("-1")).toBeNull();
    expect(decimalOf("0xzz")).toBeNull();
    expect(decimalOf(undefined)).toBeNull();
    expect(decimalOf(1.5)).toBeNull();
  });
});

/** A node that answers dry runs as told and records how it was asked. */
class ProbeNode {
  calls: { invoice: string; options: SendPaymentOptions }[] = [];
  constructor(
    private readonly outcomes: { direct: NodePayment | string; trampoline?: NodePayment | string },
    private readonly parsed: Partial<ParsedInvoice> | null = null,
  ) {}
  async parseInvoice(): Promise<ParsedInvoice> {
    if (!this.parsed) throw 'ErrorObject { code: ServerError(-32000), message: "Invalid invoice" }';
    return { network: "testnet", paymentHash: "0x" + "66".repeat(32), amount: null, udtTypeScript: null, createdAtMs: 0, expiresAtMs: null, payee: null, description: null, hashAlgorithm: "sha256", ...this.parsed };
  }
  async sendPayment(invoice: string, options: SendPaymentOptions = {}): Promise<NodePayment> {
    this.calls.push({ invoice, options });
    const outcome = options.trampolineHops?.length ? this.outcomes.trampoline : this.outcomes.direct;
    if (outcome === undefined) throw new Error("unexpected call");
    if (typeof outcome === "string") throw outcome;
    return outcome;
  }
}

const created = (fee: bigint): NodePayment => ({ paymentHash: "0x" + "77".repeat(32), status: "Created", failedError: null, fee });
const NOW = new Date("2026-11-05T10:00:00Z");

test.describe("route check", () => {
  test("dry runs directly and through the hub, with the Pay tab's 0.5 % fee cap; the outcome goes into the JSON", async () => {
    const invoice = demoFiberInvoice("testnet", BigInt(1_000_000_000));
    const node = new ProbeNode(
      { direct: 'ErrorObject { code: ServerError(-32000), message: "Send payment error: Failed to build route, PathFind error: no path found" }', trampoline: created(BigInt(2_000_000)) },
      { payee: OTHER, udtTypeScript: RUSD, expiresAtMs: Date.parse("2026-11-05T11:00:00Z") },
    );
    const report = await checkRoute(node, `  ${invoice}  `, { network: "testnet", hubNodeId: HUB, assets: ASSETS, now: NOW });
    expect(node.calls).toEqual([
      { invoice, options: { dryRun: true, maxFeeAmount: BigInt(5_000_000) } },
      { invoice, options: { dryRun: true, maxFeeAmount: BigInt(5_000_000), trampolineHops: [HUB] } },
    ]);
    expect(report).toMatchObject({
      checkedAt: NOW.toISOString(),
      dryRun: true,
      error: null,
      trampolineSkipped: null,
      target: { network: "testnet", amount: "1000000000", asset: { kind: "UDT", name: "RUSD" }, payee: OTHER, expiresAt: "2026-11-05T11:00:00.000Z", parseError: null },
    });
    expect(report.checks).toEqual([
      {
        via: "direct",
        trampolineHops: [],
        ok: false,
        status: null,
        fee: null,
        maxFeeAmount: "5000000",
        error: "Send payment error: Failed to build route, PathFind error: no path found",
        rawError: 'ErrorObject { code: ServerError(-32000), message: "Send payment error: Failed to build route, PathFind error: no path found" }',
      },
      { via: "trampoline", trampolineHops: [HUB], ok: true, status: "Created", fee: "2000000", maxFeeAmount: "5000000", error: null, rawError: null },
    ]);
    const json = diagnosticsJson(build(report));
    expect(JSON.parse(json).routeCheck.checks).toHaveLength(2);
    expect(json).not.toContain(invoice);
  });

  test("an invoice the page cannot read runs no dry run; one the node cannot parse still does", async () => {
    const node = new ProbeNode({ direct: created(BigInt(0)) });
    const bad = await checkRoute(node, "lntbs1qwerty", { network: "testnet", hubNodeId: HUB, now: NOW });
    expect(bad.checks).toEqual([]);
    expect(bad.error).toContain("Lightning invoice");
    expect(bad.trampolineSkipped).toBeNull();
    const mainnet = await checkRoute(node, demoFiberInvoice("mainnet", BigInt(100)), { network: "testnet", hubNodeId: HUB, now: NOW });
    expect(mainnet.checks).toEqual([]);
    expect(node.calls).toEqual([]);

    const unparsed = await checkRoute(node, demoFiberInvoice("testnet", BigInt(100_000_000)), { network: "testnet", hubNodeId: null, now: NOW });
    expect(unparsed.target.parseError).toBe("Invalid invoice");
    // Without the hub's live node id only the direct dry run runs, and the report says why the other did not.
    expect(unparsed.checks.map((c) => [c.via, c.ok, c.fee])).toEqual([["direct", true, "0"]]);
    expect(unparsed.trampolineSkipped).toBe("no_hub_node");
    expect(node.calls).toHaveLength(1);
    expect(node.calls[0].options).toEqual({ dryRun: true, maxFeeAmount: BigInt(500_000) });
    expect(JSON.parse(diagnosticsJson(build(unparsed))).routeCheck.trampolineSkipped).toBe("no_hub_node");
  });

  test("an invoice of the hub itself needs no trampoline dry run", async () => {
    const node = new ProbeNode({ direct: created(BigInt(0)) }, { payee: HUB });
    const report = await checkRoute(node, demoFiberInvoice("testnet", BigInt(100_000_000)), { network: "testnet", hubNodeId: HUB, now: NOW });
    expect(report.checks.map((c) => c.via)).toEqual(["direct"]);
    expect(report.trampolineSkipped).toBe("payee_is_hub");
  });
});

/** fiber-js's raw RPC, answering as told and recording each command's parameters. */
const rawFiber = (answer: (name: string, params: Record<string, unknown> | undefined) => unknown) => {
  const calls: { name: string; params: Record<string, unknown> | undefined }[] = [];
  const fiber: FiberLike = {
    start: async () => {},
    stop: async () => {},
    invokeCommand: async (name, args) => {
      const params = args?.[0] as Record<string, unknown> | undefined;
      calls.push({ name, params });
      return answer(name, params);
    },
  };
  return { fiber, calls };
};

test.describe("fiber-js adapter", () => {
  test("send_payment carries dry_run and trampoline_hops only when asked", async () => {
    const { fiber, calls } = rawFiber(() => ({ payment_hash: "0x01", status: "Created", fee: "0x10" }));
    const node = new FiberJsNode(fiber);
    expect((await node.sendPayment("fibt1x", { maxFeeAmount: BigInt(5), dryRun: true, trampolineHops: ["0x" + HUB.toUpperCase()] })).fee).toBe(BigInt(16));
    await node.sendPayment("fibt1y", { maxFeeAmount: BigInt(5) });
    expect(calls.map((c) => c.params)).toEqual([
      { invoice: "fibt1x", max_fee_amount: "0x5", trampoline_hops: [HUB], dry_run: true },
      { invoice: "fibt1y", max_fee_amount: "0x5" },
    ]);
  });

  test("readDiagnostics asks list_channels for closed channels too, and falls back when the node refuses", async () => {
    const info = { version: "0.9.1", pubkey: NODE };
    const both = rawFiber((name) => (name === "node_info" ? info : { channels: [{ channel_id: "0x1" }, "junk"] }));
    expect(await new FiberJsNode(both.fiber).readDiagnostics()).toEqual({ nodeInfo: info, channels: [{ channel_id: "0x1" }], includesClosed: true });
    expect(both.calls.map((c) => [c.name, c.params])).toEqual([
      ["node_info", undefined],
      ["list_channels", { include_closed: true }],
    ]);

    const old = rawFiber((name, params) => {
      if (name === "node_info") return info;
      if (params?.include_closed) throw 'ErrorObject { code: InvalidParams, message: "unknown field `include_closed`" }';
      return { channels: [] };
    });
    expect(await new FiberJsNode(old.fiber).readDiagnostics()).toEqual({ nodeInfo: info, channels: [], includesClosed: false });
  });
});
