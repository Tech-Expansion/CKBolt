import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Locator, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { ccc } from "@ckb-ccc/core";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { encodeUnsignedBolt11 } from "../../lib/bolt11";
import { demoFiberInvoice } from "../../lib/payment-request";
import type {
  AssetDto,
  CreateQuoteBody,
  CreateSwapBody,
  Direction,
  FiberAssetId,
  FiberNodeDto,
  HealthDto,
  LegDto,
  QuoteDto,
  Script,
  SwapDto,
  SwapEventDto,
} from "../../lib/hub/contract";
import { BRIDGE_CHANNEL_NAME, BRIDGE_PROTOCOL_VERSION } from "../../lib/wallets/fiber-browser/constants";
import { TEST_FIBER_NODE_GLOBAL } from "../../lib/wallets/fiber-browser/fiber-test-hook";
import { FakeCkbChain, rpcTransactionHash, sameScript, type JsonRpcRequest } from "./fiber-byo-fakes";
import { expectNoSeriousAxe } from "./page-checks";
import { chooseUtxoGlobal, installCkbWallet } from "./support/ckb-wallet";

/*
 * The visitor's Fiber node in the browser: the isolated page /app/fiber that runs it, and the same-origin
 * BroadcastChannel bridge other pages use to reach it (the live swap card's Fiber wallet on /app, whose own spec covers
 * the card). fiber-js is replaced by the page's documented test hook
 * (window.__ckboltTestFiberNode, lib/wallets/fiber-browser/fiber-loader.ts), which answers like fnn 0.9.1 and records
 * every call; the hub (/api/hub/**) and the public CKB RPC are answered here. Keys, the keystore, the Web Lock and the
 * bridge are the real ones. No test reaches a real network.
 */

/* --------------------------------------------------------------------------------------------- fixtures */

const PASSWORD = "testnet node pass";
/** A real testnet node (bottle) stands in for the hub's node, so its tentacle peer id is known. */
const HUB_NODE_ID = "02b6d4e3ab86a2ca2fad6fae0ecb2e1e559e0b911939872a90abdda6d20302be71";
const HUB_PEER_ID = "QmXen3eUHhywmutEzydCsW4hXBoeVmdET2FJvMX69XJ1Eo";
const HUB_WSS = "/dns4/hub.example.test/tcp/443/wss";
const HUB_WS = "/ip4/127.0.0.1/tcp/8229/ws";
const SECP_CODE_HASH = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";
const RUSD_SCRIPT: Script = {
  codeHash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hashType: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const CKB_RPC = "https://testnet.ckbapp.dev/";
const SHANNONS = BigInt(100_000_000);
const ckb = (whole: number): bigint => BigInt(whole) * SHANNONS;
const hexQ = (n: bigint) => `0x${n.toString(16)}`;

const ISOLATION_HEADERS = ["document-isolation-policy", "cross-origin-opener-policy", "cross-origin-embedder-policy"];

// Same fixture as hub-live.spec.ts: 1 BTC = 40,000,000 CKB.
const RATE = { btcUsd: 80_000, ethUsd: 2_500, ckbUsd: 0.002, source: "Test fixture", updatedAt: Date.now() };
const MICRO_USD: Record<string, bigint> = { BTC: BigInt(80_000_000_000), CKB: BigInt(2_000), RUSD: BigInt(1_000_000), CWBTC: BigInt(80_000_000_000) };
const USD: Record<string, number> = { CKB: 0.002, RUSD: 1, CWBTC: 80_000 };
const ASSET_NAMES: Record<string, string> = { CKB: "Nervos CKB", RUSD: "RUSD stablecoin", CWBTC: "CCH Wrapped BTC" };
const FEE_BPS = 100;
const SATS_PER_BTC = BigInt(100_000_000);
const BPS = BigInt(10_000);
const BOTH: Direction[] = ["ln_to_fiber", "fiber_to_ln"];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NODE_ID_SEGMENT = /(0x)?0[23][0-9a-f]{64}/gi;

const hubAsset = (id: FiberAssetId): AssetDto => ({
  id,
  symbol: id === "CWBTC" ? "cWBTC" : id,
  name: ASSET_NAMES[id] ?? id,
  displayName: null,
  iconUrl: null,
  decimals: 8,
  directions: BOTH,
  minSats: "1000",
  maxSats: "100000",
  liquidity: { lightningSats: "5000000", fiberAmount: "100000000000000" },
});

const HEALTHY: HealthDto = {
  status: "ok",
  version: "0.1.0",
  lightning: { reachable: true, network: "signet", synced: true, blockHeight: 2_100_000 },
  fiber: { reachable: true, network: "testnet", version: "0.9.1" },
  demo: { enabled: false },
  swaps: { paused: false },
};

const HUB_FIBER_NODE: FiberNodeDto = {
  nodeId: HUB_NODE_ID,
  network: "testnet",
  addresses: { p2p: ["/ip4/127.0.0.1/tcp/8228"], ws: [HUB_WSS, HUB_WS] },
  assets: [
    { id: "CKB", udtTypeScript: null, udtWhitelist: null, peerChannels: null },
    // As a hub older than the whitelist entries sends it: the node keeps fiber-js's own RUSD entry.
    { id: "RUSD", udtTypeScript: RUSD_SCRIPT, udtWhitelist: null, peerChannels: null },
  ],
  inbound: { enabled: true, amounts: { CKB: "100000000000", RUSD: "2000000000" } },
};

const apiError = (code: string, message: string) => ({ error: { code, message } });

const lightningInvoice = (sats: number) =>
  encodeUnsignedBolt11({ network: "signet", amountSats: sats, paymentHash: randomBytes(32), description: "my wallet", expirySeconds: 600 });

const shorten = (s: string, n = 10) => (s.length > n * 2 + 3 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

/* -------------------------------------------------------------------------------------------- fake hub */

interface HubRequest {
  key: string;
  body: unknown;
  /** Path of the page that sent it: /app or /app/fiber. */
  from: string;
}

/** The CKBolt hub's REST API v1 for every page of the browser context, with one swap the test moves along. */
class FakeHub {
  health: HealthDto = structuredClone(HEALTHY);
  assets: AssetDto[] = [hubAsset("CKB"), hubAsset("RUSD")];
  fiberNode: FiberNodeDto = structuredClone(HUB_FIBER_NODE);
  quoteTtlMs = 150_000;
  readonly requests: HubRequest[] = [];
  readonly quotes: QuoteDto[] = [];
  readonly swapBodies: CreateSwapBody[] = [];
  swap: SwapDto | null = null;
  events: SwapEventDto[] = [];
  /** Answers of POST /v1/fiber/inbound-channels, used in order; then 202 with the hub's amount. */
  readonly inboundAnswers: { status: number; body: unknown }[] = [];
  /** The temporary channel ids POST /v1/fiber/inbound-channels answered with, in order. */
  readonly inboundTemporaryIds: string[] = [];
  private readonly faults = new Map<string, { status: number; body: unknown }>();

  async install(context: BrowserContext) {
    await context.route("**/api/hub/**", (route) => this.handle(route));
  }

  fail(key: string, status: number, body: unknown) {
    this.faults.set(key, { status, body });
  }

  heal(key: string) {
    this.faults.delete(key);
  }

  sent(key: string, from?: string): HubRequest[] {
    return this.requests.filter((r) => r.key === key && (from === undefined || r.from === from));
  }

  advance(patch: Partial<Pick<SwapDto, "state" | "refunded" | "failureReason" | "preimage">>) {
    if (!this.swap) throw new Error("no swap to advance");
    this.swap = { ...this.swap, ...patch, updatedAt: new Date().toISOString() };
  }

  private async handle(route: Route) {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/hub/, "");
    const key = `${request.method()} ${path.replace(UUID, ":id").replace(NODE_ID_SEGMENT, ":nodeId")}`;
    let from = "";
    try {
      from = new URL(request.frame().url()).pathname;
    } catch {
      // A request without a frame.
    }
    const body = request.postDataJSON?.() ?? null;
    this.requests.push({ key, body, from });
    const fault = this.faults.get(key);
    if (fault) return route.fulfill({ status: fault.status, json: fault.body });

    switch (key) {
      case "GET /v1/health":
        return route.fulfill({ json: this.health });
      case "GET /v1/assets":
        return route.fulfill({ json: { data: this.assets } });
      case "GET /v1/fiber/node":
        return route.fulfill({ json: this.fiberNode });
      case "POST /v1/fiber/inbound-channels": {
        const answer = this.inboundAnswers.shift();
        if (answer) return route.fulfill({ status: answer.status, json: answer.body });
        const asset = body.asset as FiberAssetId;
        const temporaryChannelId = `0x${randomBytes(32).toString("hex")}`;
        this.inboundTemporaryIds.push(temporaryChannelId);
        return route.fulfill({
          status: 202,
          json: { nodeId: body.nodeId, asset, fundingAmount: this.fiberNode.inbound.amounts[asset], temporaryChannelId },
        });
      }
      case "GET /v1/fiber/inbound-channels/:nodeId":
        return route.fulfill({ json: { data: [] } });
      case "POST /v1/quotes": {
        const quote = this.makeQuote(body);
        this.quotes.push(quote);
        return route.fulfill({ status: 201, json: quote });
      }
      case "GET /v1/quotes/:id":
        return route.fulfill({ json: this.quotes.find((q) => path.endsWith(q.id)) });
      case "POST /v1/swaps": {
        this.swapBodies.push(body);
        this.swap = this.makeSwap(body);
        this.events = [{ at: new Date().toISOString(), type: "created", detail: "Swap created; waiting for your payment." }];
        return route.fulfill({ status: 201, json: this.swap });
      }
      case "GET /v1/swaps/:id":
        return this.swap && path.endsWith(this.swap.id)
          ? route.fulfill({ json: this.swap })
          : route.fulfill({ status: 404, json: apiError("not_found", "No swap with this id.") });
      case "GET /v1/swaps/:id/events":
        return route.fulfill({ json: { data: this.events } });
      default:
        return route.fulfill({ status: 404, json: apiError("not_found", "This is not a CKBolt hub API path.") });
    }
  }

  private makeQuote(body: CreateQuoteBody): QuoteDto {
    const asset = this.assets.find((a) => a.id === body.asset)!;
    const scale = BigInt(`1${"0".repeat(asset.decimals)}`);
    const amount = BigInt(body.amount);
    const keep = BigInt(10_000 - FEE_BPS);
    const btcLeg = (sats: bigint): LegDto => ({ network: "lightning", asset: "BTC", amount: sats.toString(), decimals: 8 });
    const fiberLeg = (units: bigint): LegDto => ({ network: "fiber", asset: body.asset, amount: units.toString(), decimals: asset.decimals });
    const legs =
      body.direction === "fiber_to_ln"
        ? { pay: fiberLeg(amount), receive: btcLeg((amount * MICRO_USD[body.asset] * SATS_PER_BTC * keep) / (scale * MICRO_USD.BTC * BPS)) }
        : { pay: btcLeg(amount), receive: fiberLeg((amount * MICRO_USD.BTC * scale * keep) / (SATS_PER_BTC * MICRO_USD[body.asset] * BPS)) };
    const now = Date.now();
    return {
      id: randomUUID(),
      direction: body.direction,
      asset: body.asset,
      ...legs,
      prices: { btcUsd: 80_000, assetUsd: USD[body.asset], source: "median of 3 exchanges", at: new Date(now).toISOString() },
      feeBps: FEE_BPS,
      purpose: body.purpose ?? "swap",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.quoteTtlMs).toISOString(),
      signature: "3044" + randomBytes(34).toString("hex"),
      hubPubkey: "02" + "c0ffee".repeat(10) + "abcd",
    };
  }

  private makeSwap(body: CreateSwapBody): SwapDto {
    const quote = this.quotes.find((q) => q.id === body.quoteId)!;
    const id = randomUUID();
    const holdInvoice =
      quote.pay.network === "lightning"
        ? encodeUnsignedBolt11({ network: "signet", amountSats: Number(quote.pay.amount), paymentHash: randomBytes(32), description: "CKBolt hold invoice", expirySeconds: 150 })
        : demoFiberInvoice("testnet", BigInt(quote.pay.amount));
    const now = new Date().toISOString();
    return {
      id,
      quoteId: quote.id,
      direction: quote.direction,
      asset: quote.asset,
      state: "pending",
      paymentHash: randomBytes(32).toString("hex"),
      pay: { ...quote.pay, invoice: holdInvoice },
      receive: { ...quote.receive, invoice: body.payoutInvoice },
      refunded: false,
      failureReason: null,
      preimage: null,
      demo: body.demo ?? false,
      quoteExpiresAt: quote.expiresAt,
      createdAt: now,
      updatedAt: now,
      links: { self: `/v1/swaps/${id}`, events: `/v1/swaps/${id}/events` },
    };
  }
}

/**
 * The public CKB testnet RPC the node page reads its balance from (with CORS, as the real one answers). With `chain`
 * set it is a whole fake chain (tests/e2e/fiber-byo-fakes.ts), as CCC uses it to withdraw from the node.
 */
class FakeCkbRpc {
  balance = ckb(600);
  chain: FakeCkbChain | null = null;
  readonly bodies: { method?: string; params?: unknown[] }[] = [];

  async install(context: BrowserContext) {
    await context.route(`${CKB_RPC}**`, (route) => this.handle(route));
  }

  private async handle(route: Route) {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS" };
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (this.chain) {
      const chain = this.chain;
      const payload = request.postDataJSON() as JsonRpcRequest | JsonRpcRequest[];
      for (const p of Array.isArray(payload) ? payload : [payload]) this.bodies.push(p);
      const answer = Array.isArray(payload) ? payload.map((p) => chain.handle(p)) : chain.handle(payload);
      return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(answer) });
    }
    const body = request.postDataJSON?.() ?? {};
    this.bodies.push(body);
    const answer =
      body.method === "get_cells_capacity"
        ? { jsonrpc: "2.0", id: body.id, result: { capacity: hexQ(this.balance), block_hash: `0x${"00".repeat(32)}`, block_number: "0x1" } }
        : { jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32601, message: "Method not found" } };
    return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(answer) });
  }
}

/* ------------------------------------------------------------------------------------------- fake node */

interface FakeRpcScript {
  code_hash: string;
  hash_type: string;
  args: string;
}

interface FakeChannel {
  channel_id: string;
  is_public: boolean;
  pubkey: string;
  funding_udt_type_script: FakeRpcScript | null;
  state: { state_name: string };
  local_balance: string;
  remote_balance: string;
  enabled: boolean;
}

interface FakeNodeOptions {
  /** The window property the page reads (TEST_FIBER_NODE_GLOBAL). */
  globalName: string;
  hubNodeId: string;
  /** start() rejects with this fnn error message. */
  failStart: string | null;
  /** connect_peer fails for addresses containing any of these. */
  failConnect: string[];
  channels: FakeChannel[];
  sendPayment: { status: string; failedError: string | null; throws: string | null };
  failInvoice: string | null;
  /**
   * accept_channel: the hub's open_channel message reaches the node this many accept_channel calls late, as fnn says
   * "No channel with temp id ... found" until it has arrived (a large number: it never arrives).
   */
  acceptMisses: number;
  /** accept_channel fails at once with this fnn error message. */
  failAccept: string | null;
}

interface FakeStart {
  config: string;
  fiberKey: string;
  ckbKey: string | null;
  chainSpec: string | null;
  logLevel: string | null;
  dbPrefix: string | null;
}

interface FakeCall {
  name: string;
  params: Record<string, unknown> | null;
}

interface FakeNodeState {
  opts: FakeNodeOptions;
  calls: FakeCall[];
  starts: FakeStart[];
  keyRefs: (Uint8Array | undefined)[][];
  peers: string[];
  channels: FakeChannel[];
  invoices: Record<string, { invoice: string; status: string }>;
  payments: Record<string, { invoice: string; status: string; failed_error: string | null }>;
  stops: number;
  nodeId: string | null;
  lockArgs: string | null;
  configArgs: string[][];
  /** accept_channel calls seen per temporary channel id. */
  acceptTries: Record<string, number>;
}

type FakeWindow = { __fakeFiber: FakeNodeState };

const fakeOptions = (overrides: Partial<FakeNodeOptions> = {}): FakeNodeOptions => ({
  globalName: TEST_FIBER_NODE_GLOBAL,
  hubNodeId: HUB_NODE_ID,
  failStart: null,
  failConnect: [],
  channels: [],
  sendPayment: { status: "Inflight", failedError: null, throws: null },
  failInvoice: null,
  acceptMisses: 1,
  failAccept: null,
  ...overrides,
});

const rpcChannel = (o: { local: bigint; remote: bigint; state?: string; udt?: Script | null; peer?: string }): FakeChannel => ({
  channel_id: `0x${randomBytes(32).toString("hex")}`,
  is_public: false,
  pubkey: o.peer ?? HUB_NODE_ID,
  funding_udt_type_script: o.udt ? { code_hash: o.udt.codeHash, hash_type: o.udt.hashType, args: o.udt.args } : null,
  state: { state_name: o.state ?? "ChannelReady" },
  local_balance: hexQ(o.local),
  remote_balance: hexQ(o.remote),
  enabled: true,
});

/**
 * Runs in the node page before its scripts: a fiber-js stand-in on the documented test hook. Its node id and funding
 * lock derive from the keys it is given, so the same keys give the same node, as with fiber-js. Self-contained, because
 * Playwright sends its source to the page.
 */
function installFakeNode(opts: FakeNodeOptions) {
  const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const unhex = (text: string) => {
    const clean = text.replace(/^0x/, "");
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
  };
  const sha = async (bytes: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))));
  const randomHex = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));
  const rpcError = (message: string) => `ErrorObject { code: ServerError(-32000), message: "${message}" }`;
  const state: FakeNodeState = {
    opts,
    calls: [],
    starts: [],
    keyRefs: [],
    peers: [],
    channels: opts.channels.slice(),
    invoices: {},
    payments: {},
    stops: 0,
    nodeId: null,
    lockArgs: null,
    configArgs: [],
    acceptTries: {},
  };
  const w = window as unknown as Record<string, unknown>;
  w.__fakeFiber = state;
  const node = {
    getDefaultConfig(network: string, url: string) {
      state.configArgs.push([network, url]);
      return [
        "fiber:",
        '  listening_addr: "/ip4/0.0.0.0/tcp/8228"',
        "  bootnode_addrs:",
        '    - "/ip4/54.179.226.154/tcp/8228/p2p/Qmes1EBD4yNo9Ywkfe6eRw9tG1nVNGLDmMud1xJMsoYFKy"',
        "  announce_listening_addr: true",
        `  chain: ${network}`,
        "ckb:",
        `  rpc_url: "${url}"`,
        "",
      ].join("\n");
    },
    async start(config: string, fiberKey: Uint8Array, ckbKey?: Uint8Array, chainSpec?: string, logLevel?: string, dbPrefix?: string) {
      state.starts.push({ config, fiberKey: hex(fiberKey), ckbKey: ckbKey ? hex(ckbKey) : null, chainSpec: chainSpec ?? null, logLevel: logLevel ?? null, dbPrefix: dbPrefix ?? null });
      state.keyRefs.push([fiberKey, ckbKey]);
      const fiberCopy = fiberKey.slice();
      const ckbCopy = ckbKey ? ckbKey.slice() : new Uint8Array(32);
      if (state.opts.failStart) throw rpcError(state.opts.failStart);
      state.nodeId = "02" + (await sha(fiberCopy));
      // As fnn: the secp256k1-blake160 lock of the CKB key (computed by the test), so the page can sign for it.
      const lockArgsOf = w.__testCkbLockArgs as ((key: string) => Promise<string>) | undefined;
      state.lockArgs = lockArgsOf ? await lockArgsOf(hex(ckbCopy)) : "0x" + (await sha(ckbCopy)).slice(0, 40);
    },
    async invokeCommand(name: string, args?: unknown[]) {
      const params = (args && args[0] ? JSON.parse(JSON.stringify(args[0])) : null) as Record<string, unknown> | null;
      state.calls.push({ name, params });
      const p = params ?? {};
      switch (name) {
        case "node_info":
          return {
            version: "0.9.1",
            pubkey: state.nodeId,
            default_funding_lock_script: { code_hash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8", hash_type: "type", args: state.lockArgs },
            channel_count: "0x" + state.channels.length.toString(16),
            peers_count: "0x" + state.peers.length.toString(16),
          };
        case "connect_peer": {
          const address = String(p.address);
          if (state.opts.failConnect.some((part) => address.includes(part))) throw rpcError(`Failed to dial ${address}`);
          if (!state.peers.includes(state.opts.hubNodeId)) state.peers.push(state.opts.hubNodeId);
          return null;
        }
        case "list_peers":
          return { peers: state.peers.map((pubkey) => ({ pubkey, address: "/ip4/127.0.0.1/tcp/8229/ws" })) };
        case "open_channel": {
          const id = "0x" + randomHex(32);
          state.channels.push({
            channel_id: id,
            is_public: p.public === true,
            pubkey: String(p.pubkey),
            funding_udt_type_script: null,
            state: { state_name: "NegotiatingFunding" },
            local_balance: String(p.funding_amount),
            remote_balance: "0x0",
            enabled: true,
          });
          return { temporary_channel_id: id };
        }
        case "accept_channel": {
          // As fnn 0.9.1: the opener's open_channel must have arrived; then the channel starts under its final id with
          // this node's funding on its side (the hub's share is not known to the fake).
          if (state.opts.failAccept) throw rpcError(state.opts.failAccept);
          const temp = String(p.temporary_channel_id);
          state.acceptTries[temp] = (state.acceptTries[temp] ?? 0) + 1;
          if (state.acceptTries[temp] <= state.opts.acceptMisses) throw rpcError(`No channel with temp id Hash256(${temp}) found`);
          const id = "0x" + randomHex(32);
          state.channels.push({
            channel_id: id,
            is_public: false,
            pubkey: state.opts.hubNodeId,
            funding_udt_type_script: null,
            state: { state_name: "CollaboratingFundingTx" },
            local_balance: String(p.funding_amount),
            remote_balance: "0x0",
            enabled: true,
          });
          return { channel_id: id };
        }
        case "list_channels":
          return { channels: state.channels };
        case "shutdown_channel": {
          if (p.force) throw rpcError("close_script and fee_rate should not be set when force is true");
          const found = state.channels.find((c) => c.channel_id === p.channel_id);
          if (!found) throw rpcError("Channel not found");
          found.state = { state_name: "ShuttingDown" };
          return null;
        }
        case "new_invoice": {
          if (state.opts.failInvoice) throw rpcError(state.opts.failInvoice);
          const paymentHash = "0x" + (await sha(unhex(String(p.payment_preimage))));
          const make = w.__testFiberInvoice as ((amount: string) => Promise<string>) | undefined;
          const invoice = make ? await make(String(p.amount)) : "fibt1fakeinvoice";
          state.invoices[paymentHash] = { invoice, status: "Open" };
          return { invoice_address: invoice, invoice: { currency: p.currency, amount: p.amount, data: { payment_hash: paymentHash, attrs: [] } } };
        }
        case "get_invoice": {
          const found = state.invoices[String(p.payment_hash)];
          if (!found) throw rpcError("Invoice not found");
          return { invoice_address: found.invoice, invoice: { data: { payment_hash: p.payment_hash } }, status: found.status };
        }
        case "send_payment": {
          const behaviour = state.opts.sendPayment;
          const paymentHash = "0x" + randomHex(32);
          // A dry run keeps no payment session, as fnn.
          if (p.dry_run === true) return { payment_hash: paymentHash, status: "Created", failed_error: null, fee: "0x0" };
          if (behaviour.throws) throw rpcError(behaviour.throws);
          state.payments[paymentHash] = { invoice: String(p.invoice), status: behaviour.status, failed_error: behaviour.failedError };
          return { payment_hash: paymentHash, status: behaviour.status, failed_error: behaviour.failedError, fee: "0x0" };
        }
        case "get_payment": {
          const found = state.payments[String(p.payment_hash)];
          if (!found) throw rpcError("Payment session not found");
          return { payment_hash: p.payment_hash, status: found.status, failed_error: found.failed_error, fee: "0x0" };
        }
        default:
          throw new TypeError(`fiber.default.${name} is not a function`);
      }
    },
    async stop() {
      state.stops++;
    },
  };
  w[opts.globalName] = node;
}

/** What the fake node saw, without the key arrays. */
const fake = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as FakeWindow).__fakeFiber;
    return {
      calls: s.calls,
      starts: s.starts,
      peers: s.peers,
      channels: s.channels,
      nodeId: s.nodeId,
      lockArgs: s.lockArgs,
      configArgs: s.configArgs,
      stops: s.stops,
      invoices: s.invoices,
      payments: s.payments,
    };
  });

const callsOf = async (page: Page, name: string) => (await fake(page)).calls.filter((c) => c.name === name).map((c) => c.params);

/** True when every key array the page handed fiber-js has been overwritten with zeros. */
const keysWiped = (page: Page) =>
  page.evaluate(() => (window as unknown as FakeWindow).__fakeFiber.keyRefs.every((pair) => pair.every((k) => !k || k.every((b) => b === 0))));

const setFake = (page: Page, patch: Partial<FakeNodeOptions>) =>
  page.evaluate((p) => Object.assign((window as unknown as FakeWindow).__fakeFiber.opts, p), patch);

const setChannels = (page: Page, channels: FakeChannel[]) =>
  page.evaluate((list) => {
    (window as unknown as FakeWindow).__fakeFiber.channels = list;
  }, channels);

/* ----------------------------------------------------------------------------------------------- helpers */

interface Harness {
  hub: FakeHub;
  rpc: FakeCkbRpc;
  /** Every request any page of the context sent: URL and body. */
  sent: { url: string; body: string }[];
}

async function harness(context: BrowserContext, configure?: (hub: FakeHub, rpc: FakeCkbRpc) => void): Promise<Harness> {
  const hub = new FakeHub();
  const rpc = new FakeCkbRpc();
  configure?.(hub, rpc);
  await hub.install(context);
  await rpc.install(context);
  await context.route("**/api/rate", (route) => route.fulfill({ json: RATE }));
  const sent: Harness["sent"] = [];
  context.on("request", (request) => sent.push({ url: request.url(), body: request.postData() ?? "" }));
  return { hub, rpc, sent };
}

/** The args of CKB's secp256k1-blake160 lock for a secret key: blake160 of its compressed public key, as fnn and CCC. */
const ckbLockArgs = (keyHex: string): string => ccc.hashCkb(secp256k1.getPublicKey(hexToBytes(keyHex), true)).slice(0, 42);

/** Opens /app/fiber with the fake node installed. */
async function openNodePage(page: Page, options: Partial<FakeNodeOptions> = {}) {
  await page.addInitScript(installFakeNode, fakeOptions(options));
  await page.exposeFunction("__testFiberInvoice", (amountHex: string) => demoFiberInvoice("testnet", BigInt(amountHex)));
  await page.exposeFunction("__testCkbLockArgs", ckbLockArgs);
  await page.goto("/app/fiber");
  // The node page renders on the client only.
  await expect(page.getByTestId("fiber-node-key")).toBeVisible({ timeout: 20_000 });
}

const hubPanel = (page: Page) => page.getByTestId("fiber-node-hub");
/** "Channel with the hub": its row per asset, a row's checkbox (named by its symbol), the one button and the run's summary. */
const hubRow = (page: Page, asset: string) => page.getByTestId(`fiber-node-hub-row-${asset}`);
const hubBox = (page: Page, symbol: string) => page.getByTestId("fiber-node-hub-request").getByRole("checkbox", { name: symbol, exact: true });
const hubOpen = (page: Page) => page.getByTestId("fiber-node-hub-open");
const hubSummary = (page: Page) => page.getByTestId("fiber-node-hub-summary");

/** Waits until the page knows the hub's node, so the node starts with the hub as its bootnode. */
const hubKnown = (page: Page) => expect(hubPanel(page)).toContainText("Hub node", { timeout: 20_000 });

async function createNode(page: Page, password = PASSWORD) {
  await page.getByLabel("Password, at least 8 characters").fill(password);
  await page.getByLabel("Repeat the password").fill(password);
  await page.getByRole("button", { name: "Create node" }).click();
  await expect(page.getByTestId("fiber-node-address")).toBeVisible({ timeout: 30_000 });
}

async function unlock(page: Page, password = PASSWORD) {
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Unlock and start node" }).click();
}

/** Waits until no tab holds the node's Web Lock (a closed tab frees it a moment after it closes). */
const lockFreed = (page: Page) =>
  expect
    .poll(() => page.evaluate(async () => ((await navigator.locks.query()).held ?? []).some((lock) => lock.name === "ckbolt:fiber-browser:testnet:node")), {
      timeout: 30_000,
    })
    .toBe(false);

/** A node page with a running, hub-connected node. */
async function runningNode(page: Page, options: Partial<FakeNodeOptions> = {}) {
  await openNodePage(page, options);
  await hubKnown(page);
  await createNode(page);
  await expect(hubPanel(page)).toContainText("Connected");
}

/** The tag in the header of the numbered panel titled `title` (its heading reads "01Node key"). */
const tagOf = (page: Page, title: string) =>
  page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: new RegExp(`^\\d+\\s*${title}$`) }) })
    .locator("header > span")
    .last();

/** Opens the "?" popover named `label` inside `scope` and returns it (Radix renders it as a dialog with that name). */
async function openTip(scope: Page | Locator, label: string): Promise<Locator> {
  const page = "page" in scope ? scope.page() : scope;
  await scope.getByRole("button", { name: label, exact: true }).click();
  const tip = page.getByRole("dialog", { name: label });
  await expect(tip).toBeVisible();
  return tip;
}

/** Fails when any request, the page or the bridge carried one of `secrets`. */
async function expectNowhere(secrets: string[], sources: { name: string; text: string }[]) {
  for (const secret of secrets.filter(Boolean)) {
    for (const source of sources) expect(source.text.toLowerCase().includes(secret.toLowerCase()), `${source.name} carries a secret`).toBe(false);
  }
}

const requestsText = (h: Harness) => h.sent.map((s) => `${s.url}\n${s.body}`).join("\n");

/** Every element must fit the viewport width (as in app.spec.ts). */
async function expectNoHorizontalOverflow(page: Page) {
  const overflowing = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const el of document.querySelectorAll("main *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || el.children.length) continue;
      if (getComputedStyle(el).display === "none") continue;
      let p = el.parentElement;
      let scrolls = false;
      while (p) {
        const o = getComputedStyle(p).overflowX;
        if (o === "auto" || o === "scroll") scrolls = true;
        p = p.parentElement;
      }
      if (!scrolls && r.right > vw + 1 && (el.textContent ?? "").trim()) out.push(`${el.tagName} "${(el.textContent ?? "").trim().slice(0, 40)}"`);
    }
    return out.slice(0, 10);
  });
  expect(overflowing).toEqual([]);
}

/* ------------------------------------------------------------------------------------ the isolated route */

test.describe("browser Fiber node: the isolated page", () => {
  test("only /app/fiber is cross-origin isolated; /app and the funding page keep working wallet popups, and the site's other headers stay", async ({ page, request }) => {
    const fiber = await request.get("/app/fiber");
    expect(fiber.status()).toBe(200);
    const headers = fiber.headers();
    expect(headers["document-isolation-policy"]).toBe("isolate-and-credentialless");
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(headers["cross-origin-embedder-policy"]).toMatch(/^(require-corp|credentialless)$/);
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    for (const path of ["/app", "/app?mode=swap", "/", "/app/fiber/fund"]) {
      const other = await request.get(path);
      expect(other.status(), path).toBe(200);
      for (const name of ISOLATION_HEADERS) expect(other.headers()[name], `${name} on ${path}`).toBeUndefined();
      expect(other.headers()["x-frame-options"], path).toBe("DENY");
    }

    await page.goto("/app/fiber");
    await expect(page.getByTestId("fiber-node")).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => ({ isolated: crossOriginIsolated, shared: typeof SharedArrayBuffer, locks: !!navigator.locks }))).toEqual({
      isolated: true,
      shared: "function",
      locks: true,
    });
    await page.goto("/app?mode=swap");
    await expect(page.getByTestId("mode-swap")).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
  });

  test("says what it is, honestly: testnet, experimental, keys made and kept in this browser, the limits before funding", async ({ page, context }) => {
    await harness(context);
    await openNodePage(page);
    await expect(page.getByText("Testnet, experimental: a Fiber node in your browser")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your Fiber node." })).toBeVisible();
    await expect(page.locator("main")).toContainText("A Fiber node in this tab, for live swaps on testnet.");
    const about = await openTip(page, "About the browser node");
    await expect(about).toContainText("fiber-js 0.9.1 runs in this tab on CKB testnet.");
    await expect(about).toContainText("encrypted with your password");
    await page.keyboard.press("Escape");
    const limits = page.getByTestId("fiber-node-limits");
    await expect(limits).toContainText("Testnet only, and experimental.");
    await expect(limits).toContainText("Keep this tab open while a swap runs.");
    await expect(limits).toContainText("No watchtower: close channels from this page.");
    await expect(limits).toContainText("Only one tab runs the node at a time.");
    await expect(await openTip(limits, "About the limits")).toContainText("No watchtower watches a browser node");
    await page.keyboard.press("Escape");
    await expect(tagOf(page, "Node key")).toHaveText("No key yet");
    const create = page.getByTestId("fiber-node-create");
    await expect(create).toContainText("A lost password cannot be recovered.");
    await expect(await openTip(create, "About the node key")).toContainText("CKBolt never sees them, and nobody can recover a lost password.");
  });

  test("fiber-js (15 MB) is not downloaded with the node page or the app page", async ({ page }) => {
    for (const path of ["/app/fiber", "/app?mode=swap"]) {
      await page.goto(path);
      await expect(page.locator(path === "/app/fiber" ? "[data-testid=fiber-node]" : "[data-testid=mode-swap]")).toBeVisible({ timeout: 20_000 });
      await page.waitForLoadState("networkidle");
      const largest = await page.evaluate(() =>
        Math.max(0, ...performance.getEntriesByType("resource").map((e) => (e as PerformanceResourceTiming).decodedBodySize || 0)),
      );
      expect(largest, path).toBeLessThan(3_000_000);
    }
  });

  test("without the test hook, Create node loads the real fiber-js on demand, on the isolated page", async ({ page, context }) => {
    test.setTimeout(90_000);
    // Nothing leaves the machine: the real node would dial testnet otherwise.
    await context.route(/^https?:\/\/(?!localhost[:/])/, (route) => route.abort());
    await page.goto("/app/fiber");
    await expect(page.getByTestId("fiber-node-create")).toBeVisible({ timeout: 20_000 });
    const before = await page.evaluate(() => performance.getEntriesByType("resource").length);
    await page.getByLabel("Password, at least 8 characters").fill(PASSWORD);
    await page.getByLabel("Repeat the password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create node" }).click();
    await expect(page.getByTestId("fiber-node-status")).toContainText(/Starting the node: loading fiber-js 0\.9\.1|Node id|could not start/, { timeout: 30_000 });
    await expect
      .poll(
        () =>
          page.evaluate(
            (from) =>
              performance
                .getEntriesByType("resource")
                .slice(from)
                .some((e) => (e as PerformanceResourceTiming).decodedBodySize > 10_000_000),
            before,
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  });

  test("a client-side arrival without the page's headers reloads once, then explains what is missing", async ({ page }) => {
    let documents = 0;
    await page.route("**/app/fiber", async (route) => {
      documents++;
      const response = await route.fetch();
      const headers = { ...response.headers() };
      for (const name of ISOLATION_HEADERS) delete headers[name];
      await route.fulfill({ response, headers });
    });
    await page.goto("/app/fiber");
    const notice = page.getByTestId("fiber-node-isolation");
    await expect(notice).toBeVisible({ timeout: 20_000 });
    expect(documents).toBe(2);
    await expect(page.getByRole("heading", { name: "This browser cannot run the node here" })).toBeVisible();
    await expect(notice).toContainText("The page is not cross-origin isolated.");
    await expect(notice).toContainText("SharedArrayBuffer is not available.");
    await expect(notice).not.toContainText("The page is not on HTTPS or localhost.");
    await expect(page.getByTestId("fiber-node-key")).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem("ckbolt:fiber-browser:testnet:isolation-reload"))).not.toBeNull();

    // With its headers back, the page is isolated and clears the mark.
    await page.unroute("**/app/fiber");
    await page.getByRole("button", { name: "Reload the page" }).click();
    await expect(page.getByTestId("fiber-node-key")).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => sessionStorage.getItem("ckbolt:fiber-browser:testnet:isolation-reload"))).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------- the node key */

test.describe("browser Fiber node: key and node", () => {
  test("creates the node: keys made in the browser, stored encrypted, wiped from page memory, and sent nowhere", async ({ page, context }) => {
    test.setTimeout(90_000);
    const h = await harness(context);
    await openNodePage(page);
    await hubKnown(page);

    // Password rules first.
    const password = page.getByLabel("Password, at least 8 characters");
    await password.fill("short");
    await page.getByLabel("Repeat the password").fill("short");
    await page.getByRole("button", { name: "Create node" }).click();
    await expect(page.getByTestId("fiber-node-key-error")).toHaveText("Use at least 8 characters.");
    await expect(password).toHaveAttribute("aria-invalid", "true");
    await password.fill(PASSWORD);
    await page.getByLabel("Repeat the password").fill(`${PASSWORD}!`);
    await page.getByRole("button", { name: "Create node" }).click();
    await expect(page.getByTestId("fiber-node-key-error")).toHaveText("The two passwords differ.");
    expect((await fake(page)).starts).toEqual([]);

    await createNode(page);
    const state = await fake(page);
    expect(state.starts).toHaveLength(1);
    const start = state.starts[0];
    expect(start.fiberKey).toMatch(/^[0-9a-f]{64}$/);
    expect(start.ckbKey).toMatch(/^[0-9a-f]{64}$/);
    expect(start.fiberKey).not.toBe(start.ckbKey);
    expect(start.logLevel).toBe("info");
    expect(start.chainSpec).toBeNull();
    // One IndexedDB per network and per key: the tag is the start of sha256(P2P key).
    expect(start.dbPrefix).toBe(`/ckbolt-fiber/testnet/${bytesToHex(sha256(hexToBytes(start.fiberKey))).slice(0, 16)}`);
    // fiber-js's testnet config for the default public RPC, with the hub as the only bootnode and nothing announced.
    expect(state.configArgs).toEqual([["testnet", CKB_RPC]]);
    expect(start.config).toContain(`  bootnode_addrs:\n    - "${HUB_WSS}/p2p/${HUB_PEER_ID}"\n    - "${HUB_WS}/p2p/${HUB_PEER_ID}"\n`);
    expect(start.config).not.toContain("/tcp/8228/p2p/Qmes1");
    expect(start.config).toContain("announce_listening_addr: false");
    expect(await keysWiped(page)).toBe(true);

    // Status, id, address and on-chain balance.
    await expect(tagOf(page, "Node")).toHaveText("Running");
    await expect(tagOf(page, "Node key")).toHaveText("Unlocked");
    const status = page.getByTestId("fiber-node-status");
    await expect(status).toContainText(shorten(state.nodeId!, 10));
    await expect(status).toContainText("fiber-js 0.9.1");
    await expect(status).toContainText("600 CKB");
    await expect(status).toContainText("read from testnet.ckbapp.dev");
    const address = ccc.Address.from({ script: { codeHash: SECP_CODE_HASH, hashType: "type", args: state.lockArgs! }, prefix: "ckt" }).toString();
    await expect(page.getByTestId("fiber-node-address")).toContainText(address);
    const fund = page.getByTestId("fiber-node-fund");
    await expect(fund).toHaveText("Fund this node");
    await expect(fund).toHaveAttribute("href", `/app/fiber/fund?address=${address}`);
    await expect(fund).toHaveAttribute("target", "_blank");
    await expect(fund).toHaveAttribute("rel", /noopener/);
    // The balance is read for the node's public lock only.
    expect(h.rpc.bodies.at(-1)).toMatchObject({ method: "get_cells_capacity", params: [{ script: { code_hash: SECP_CODE_HASH, hash_type: "type", args: state.lockArgs }, script_type: "lock" }] });

    // Connected to the hub at its first WebSocket address, with its peer id.
    expect(await callsOf(page, "connect_peer")).toEqual([{ address: `${HUB_WSS}/p2p/${HUB_PEER_ID}` }]);
    await expect(hubPanel(page)).toContainText(shorten(HUB_NODE_ID, 10));

    // The keystore: scrypt with the named cost and AES-GCM, the public node id, nothing in clear.
    const stored = await page.evaluate(() => ({ ...localStorage }));
    // The keystore, and the hub's public node id, kept so the wallet knows the hub while it is out of reach.
    expect(Object.keys(stored).filter((k) => k.startsWith("ckbolt:fiber-browser")).sort()).toEqual([
      "ckbolt:fiber-browser:testnet:hub-node-id",
      "ckbolt:fiber-browser:testnet:keystore",
    ]);
    expect(stored["ckbolt:fiber-browser:testnet:hub-node-id"]).toBe(HUB_NODE_ID);
    const record = JSON.parse(stored["ckbolt:fiber-browser:testnet:keystore"]);
    expect(record).toMatchObject({ version: 1, network: "testnet", kdf: { name: "scrypt", logN: 16, r: 8, p: 1 }, cipher: { name: "AES-GCM" }, nodeId: state.nodeId });

    const secrets = [start.fiberKey, start.ckbKey!, PASSWORD];
    await expectNowhere(secrets, [
      { name: "requests", text: requestsText(h) },
      { name: "local storage", text: JSON.stringify(stored) },
      { name: "session storage", text: JSON.stringify(await page.evaluate(() => ({ ...sessionStorage }))) },
      { name: "page", text: await page.content() },
    ]);
    // Only reads went to the hub.
    expect(h.hub.requests.map((r) => r.key).filter((k) => !k.startsWith("GET "))).toEqual([]);
  });

  test("a reload asks for the password and brings back the same node, keys and database", async ({ page, context }) => {
    test.setTimeout(90_000);
    await harness(context);
    await runningNode(page);
    const first = await fake(page);

    await page.reload();
    await expect(page.getByTestId("fiber-node-unlock")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("fiber-node-unlock")).toContainText(`Node ${shorten(first.nodeId!, 8)} is stored in this browser.`);
    await expect(tagOf(page, "Node key")).toHaveText("Locked");
    await expect(tagOf(page, "Node")).toHaveText("Locked");

    await unlock(page, "not the password");
    await expect(page.getByTestId("fiber-node-key-error")).toHaveText("Wrong password, or the stored node key was changed.");
    expect((await fake(page)).starts).toEqual([]);

    await hubKnown(page);
    await unlock(page);
    await expect(page.getByTestId("fiber-node-address")).toBeVisible({ timeout: 30_000 });
    const second = await fake(page);
    expect(second.nodeId).toBe(first.nodeId);
    expect(second.starts[0].fiberKey).toBe(first.starts[0].fiberKey);
    expect(second.starts[0].ckbKey).toBe(first.starts[0].ckbKey);
    expect(second.starts[0].dbPrefix).toBe(first.starts[0].dbPrefix);
    // The hub is dialled again on every start.
    expect(await callsOf(page, "connect_peer")).toHaveLength(1);
    await expect(hubPanel(page)).toContainText("Connected");
  });

  test("only one tab runs the node: a second tab says so, does not start it, and takes over once the first closes", async ({ page, context }) => {
    test.setTimeout(120_000);
    await harness(context);
    await runningNode(page);
    const nodeId = (await fake(page)).nodeId!;

    const second = await context.newPage();
    await openNodePage(second);
    await expect(second.getByTestId("fiber-node-other-tab")).toContainText("This node runs in another tab or window.");
    await expect(tagOf(second, "Node")).toHaveText("Runs in another tab");
    await unlock(second);
    await expect(tagOf(second, "Node")).toHaveText("Runs in another tab", { timeout: 30_000 });
    expect((await fake(second)).starts).toEqual([]);
    expect(await keysWiped(second)).toBe(true);

    await page.close();
    await lockFreed(second);
    await expect(second.getByTestId("fiber-node-unlock")).toBeVisible();
    await unlock(second);
    await expect(second.getByTestId("fiber-node-address")).toBeVisible({ timeout: 30_000 });
    expect((await fake(second)).nodeId).toBe(nodeId);
    await expect(tagOf(second, "Node")).toHaveText("Running");
  });

  test("backup downloads the encrypted keystore with a warning; forget takes two steps; restore needs the right backup and password", async ({ page, context }) => {
    test.setTimeout(120_000);
    const h = await harness(context);
    await runningNode(page);
    const first = await fake(page);

    const backup = page.getByTestId("fiber-node-backup");
    await expect(backup).toContainText("Keep the file and password private. It does not restore channels.");
    const backupTip = await openTip(backup, "About the backup");
    await expect(backupTip).toContainText("Anyone with the file and the password controls the node's funds");
    await expect(backupTip).toContainText("open channels live in this browser's storage and cannot be restored from it");
    await page.keyboard.press("Escape");
    const [download] = await Promise.all([page.waitForEvent("download"), backup.getByRole("link", { name: "Download encrypted backup" }).click()]);
    expect(download.suggestedFilename()).toBe(`ckbolt-fiber-node-testnet-${first.nodeId!.slice(0, 8)}.json`);
    const file = readFileSync(await download.path(), "utf8");
    const stored = await page.evaluate(() => localStorage.getItem("ckbolt:fiber-browser:testnet:keystore"));
    expect(JSON.parse(file)).toEqual(JSON.parse(stored!));
    await expectNowhere([first.starts[0].fiberKey, first.starts[0].ckbKey!, PASSWORD], [{ name: "backup file", text: file }]);

    // Forget: a confirmation that can be cancelled.
    await page.getByRole("button", { name: "Forget this node" }).click();
    const confirm = page.getByTestId("fiber-node-forget");
    await expect(confirm).toContainText("Without a backup, all its CKB is lost, channels included.");
    await confirm.getByRole("button", { name: "Keep the node" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(tagOf(page, "Node")).toHaveText("Running");
    await page.getByRole("button", { name: "Forget this node" }).click();
    await page.getByRole("button", { name: "Yes, forget it" }).click();
    await expect(page.getByTestId("fiber-node-create")).toBeVisible();
    await expect(tagOf(page, "Node")).toHaveText("Locked");
    expect(await page.evaluate(() => localStorage.getItem("ckbolt:fiber-browser:testnet:keystore"))).toBeNull();
    expect((await fake(page)).stops).toBeGreaterThanOrEqual(1);

    // Restore refuses a backup for another network and a wrong password, and stores nothing then.
    const restore = page.getByTestId("fiber-node-restore");
    await restore.getByText("Restore from a backup").click();
    const text = restore.getByLabel("Backup file contents");
    const pass = restore.getByLabel("The backup's password");
    await text.fill(JSON.stringify({ ...JSON.parse(file), network: "mainnet" }));
    await pass.fill(PASSWORD);
    await restore.getByRole("button", { name: "Restore and start node" }).click();
    await expect(page.getByTestId("fiber-node-key-error")).toHaveText("This is not a CKBolt Fiber node backup for this network.");
    await text.fill(file);
    await pass.fill("wrong password!");
    await restore.getByRole("button", { name: "Restore and start node" }).click();
    await expect(page.getByTestId("fiber-node-key-error")).toHaveText("Wrong password, or the stored node key was changed.");
    expect(await page.evaluate(() => localStorage.getItem("ckbolt:fiber-browser:testnet:keystore"))).toBeNull();

    await pass.fill(PASSWORD);
    await restore.getByRole("button", { name: "Restore and start node" }).click();
    await expect(page.getByTestId("fiber-node-address")).toBeVisible({ timeout: 30_000 });
    const restored = await fake(page);
    expect(restored.starts.at(-1)?.fiberKey).toBe(first.starts[0].fiberKey);
    expect(restored.nodeId).toBe(first.nodeId);
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem("ckbolt:fiber-browser:testnet:keystore")))!)).toMatchObject({ ciphertext: JSON.parse(file).ciphertext });
    await expectNowhere([first.starts[0].fiberKey, first.starts[0].ckbKey!, PASSWORD], [{ name: "requests", text: requestsText(h) }]);
  });

  test("a node that fails to start says why, frees the lock, and starts on the next unlock", async ({ page, context }) => {
    test.setTimeout(90_000);
    await harness(context);
    await openNodePage(page, { failStart: "Failed to load contract cell deps" });
    await hubKnown(page);
    await page.getByLabel("Password, at least 8 characters").fill(PASSWORD);
    await page.getByLabel("Repeat the password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create node" }).click();
    await expect(tagOf(page, "Node")).toHaveText("Failed", { timeout: 30_000 });
    const status = page.getByTestId("fiber-node-status");
    await expect(status).toContainText("The node could not start. Reload the page and unlock again.");
    await expect(status).toContainText("Failed to load contract cell deps");
    expect(await keysWiped(page)).toBe(true);

    await setFake(page, { failStart: null });
    await unlock(page);
    await expect(page.getByTestId("fiber-node-address")).toBeVisible({ timeout: 30_000 });
    await expect(tagOf(page, "Node")).toHaveText("Running");
  });
});

/* --------------------------------------------------------------------------------------- channels, inbound */

test.describe("browser Fiber node: channels with the hub", () => {
  test("offers no channel of its own to the hub, says the node pays at once from what it puts in, and closes the hub's channel cooperatively", async ({ page, context }) => {
    test.setTimeout(90_000);
    await harness(context);
    await runningNode(page, { channels: [rpcChannel({ local: ckb(401), remote: ckb(0) })] });
    const panel = hubPanel(page);
    const payNote = panel.getByTestId("fiber-node-hub-pay-note");
    await expect(payNote).toContainText("A new channel lets it pay 1,101 CKB at once.");
    // The CKB row reads Open with what the channel moves, and rests; a channel keeps what went in: the "?" says how to put in more.
    await expect(hubRow(page, "CKB")).toHaveAttribute("data-status", "open");
    await expect(panel.getByTestId("fiber-node-hub-line-CKB")).toHaveText("You can send 401 CKB · receive 0 CKB");
    await expect(hubBox(page, "CKB")).toBeDisabled();
    await expect(panel.getByTestId("fiber-node-contribution")).toHaveCount(0);
    await expect(await openTip(panel, "About the channel with the hub")).toContainText(
      "Fiber cannot add funds to an open channel yet: to put in more CKB, close the CKB channel, then open a new one.",
    );
    await page.keyboard.press("Escape");
    await expect(await openTip(payNote, "About paying from your node")).toContainText("The hub takes payments only over channels it opened itself");
    await page.keyboard.press("Escape");
    await expect(panel.getByRole("button", { name: /channel to the hub/ })).toHaveCount(0);
    expect(await callsOf(page, "open_channel")).toEqual([]);

    // The hub's channel: what it can send and receive, then a cooperative close after a confirmation.
    const channels = page.getByTestId("fiber-node-channels");
    await expect(channels).toContainText("CKBolt hub");
    const opened = (await fake(page)).channels[0];
    const row = channels.locator("tbody tr").first();
    await expect(row).toContainText("Ready");
    await expect(row.locator("td").nth(3)).toHaveText("401");
    await expect(row.locator("td").nth(4)).toHaveText("0");
    const confirm = page.getByTestId("fiber-node-close-confirm");
    await row.getByRole("button", { name: "Close" }).click();
    await expect(row.getByRole("button", { name: "Close" })).toHaveAttribute("aria-expanded", "true");
    await confirm.getByRole("button", { name: "Keep" }).click();
    await expect(confirm).toHaveCount(0);
    expect(await callsOf(page, "shutdown_channel")).toEqual([]);
    await row.getByRole("button", { name: "Close" }).click();
    // By default the node's share returns to the node: no close_script goes to fnn.
    await expect(confirm.getByRole("radio", { name: /^This node/ })).toHaveAttribute("aria-checked", "true");
    await confirm.getByRole("button", { name: "Yes, close" }).click();
    await expect(page.getByTestId("fiber-node-hub-notice")).toHaveText("Closing the channel cooperatively. Its share returns to the node's address once confirmed.");
    expect(await callsOf(page, "shutdown_channel")).toEqual([{ channel_id: opened.channel_id }]);
    await expect(row).toContainText("Closing");
    await expect(confirm).toHaveCount(0);
  });

  test("asks the hub for a channel only once the node holds enough CKB to put its share in", async ({ page, context }) => {
    test.setTimeout(90_000);
    const h = await harness(context);
    await runningNode(page);
    const panel = hubPanel(page);
    // What each new channel takes: the hub funds it; the node puts in its CKB, or a token channel's CKB reserve.
    await expect(panel.getByTestId("fiber-node-hub-line-CKB")).toHaveText("Hub funds 1,000 CKB");
    await expect(panel.getByTestId("fiber-node-hub-line-RUSD")).toHaveText("Hub funds 20 RUSD · needs 181 CKB reserve");
    // The fake node holds 600 CKB: enough for the RUSD reserve, not for its 1,200 CKB share of the CKB channel.
    await hubBox(page, "CKB").check();
    await expect(panel.getByTestId("fiber-node-hub-total")).toHaveText("Needs 1,201 CKB on chain · you have 600 CKB");
    await expect(panel.getByTestId("fiber-node-hub-short")).toHaveText("Not enough CKB on chain. Add 601 CKB first.");
    await expect(hubOpen(page)).toBeDisabled();
    await hubBox(page, "CKB").uncheck();
    await hubBox(page, "RUSD").check();
    await expect(panel.getByTestId("fiber-node-hub-total")).toHaveText("Needs 181 CKB on chain · you have 600 CKB");
    await expect(hubOpen(page)).toBeEnabled();
    expect(h.hub.sent("POST /v1/fiber/inbound-channels")).toEqual([]);

    // Both: their needs add up; funded, the one button opens them.
    await hubBox(page, "CKB").check();
    await expect(panel.getByTestId("fiber-node-hub-total")).toHaveText("Needs 1,382 CKB on chain · you have 600 CKB");
    await expect(hubOpen(page)).toBeDisabled();
    h.rpc.balance = ckb(1_382);
    await page.getByRole("button", { name: "Refresh balance" }).click();
    await expect(hubOpen(page)).toBeEnabled();
    await expect(hubOpen(page)).toHaveText("Open 2 channels");
    await expect(panel.getByTestId("fiber-node-hub-short")).toHaveCount(0);
  });

  test("waits while the hub says it cannot fund a channel in a token now, and asks for the others", async ({ page, context }) => {
    test.setTimeout(90_000);
    const h = await harness(context, (hub, rpc) => {
      hub.fiberNode.inbound.fundable = { CKB: false, RUSD: true };
      rpc.balance = ckb(1_201);
    });
    await runningNode(page);
    await expect(hubRow(page, "CKB")).toHaveAttribute("data-status", "unfundable");
    await expect(hubRow(page, "CKB")).toContainText("Hub can't fund now");
    await expect(hubBox(page, "CKB")).toBeDisabled();
    await expect(hubBox(page, "CKB")).toHaveAttribute("title", "The hub cannot fund a new CKB channel right now. Try again later.");
    await expect(hubBox(page, "RUSD")).toBeEnabled();
    expect(h.hub.sent("POST /v1/fiber/inbound-channels")).toEqual([]);
  });

  test("reads the hub's node again after a refused request, so a token the hub cannot fund waits", async ({ page, context }) => {
    test.setTimeout(90_000);
    const h = await harness(context, (_hub, rpc) => {
      rpc.balance = ckb(1_201);
    });
    await runningNode(page);
    const panel = hubPanel(page);
    await hubBox(page, "CKB").check();
    await expect(hubOpen(page)).toBeEnabled();
    const readsBefore = h.hub.sent("GET /v1/fiber/node").length;
    const refusal = "The hub cannot fund a 1000 CKB inbound channel right now without short-changing swap payouts. Try again later.";
    h.hub.inboundAnswers.push({ status: 422, body: apiError("insufficient_liquidity", refusal) });
    h.hub.fiberNode.inbound.fundable = { CKB: false, RUSD: true };
    await hubOpen(page).click();
    await expect(panel.getByTestId("fiber-node-hub-reason-CKB")).toHaveText(refusal);
    await expect(hubSummary(page)).toHaveText("No channel opened. Its row says why.");
    await expect.poll(() => h.hub.sent("GET /v1/fiber/node").length).toBeGreaterThan(readsBefore);
    // The row keeps the hub's words, and rests while the hub cannot fund it.
    await expect(hubRow(page, "CKB")).toHaveAttribute("data-status", "failed");
    await expect(hubBox(page, "CKB")).toBeDisabled();
    await expect(hubBox(page, "CKB")).toHaveAttribute("title", "The hub cannot fund a new CKB channel right now. Try again later.");
    expect(h.hub.sent("POST /v1/fiber/inbound-channels")).toHaveLength(1);
  });

  test("the visitor chooses what the node puts in for each request: no restart, checked against the node's CKB, accepted with accept_channel", async ({ page, context }) => {
    test.setTimeout(120_000);
    const h = await harness(context, (_hub, rpc) => {
      rpc.balance = ckb(1_300);
    });
    await runningNode(page);
    const panel = hubPanel(page);
    const field = panel.getByLabel("Your node puts in");
    const open = hubOpen(page);
    await expect(field).toHaveValue("1200");
    // fnn never accepts a CKB channel by itself: the node accepts the hub's with the amount chosen per request.
    expect((await fake(page)).starts[0].config).toContain("auto_accept_channel_ckb_funding_amount: 0\n");
    await hubBox(page, "CKB").check();
    await expect(open).toBeEnabled();
    await expect(panel.getByRole("button", { name: "Restart node" })).toHaveCount(0);

    // An amount below the minimum (the 99 CKB reserve and about a hundred to pay with) holds the CKB request back.
    await field.fill("150");
    await expect(panel.getByTestId("fiber-node-contribution")).toContainText("Whole CKB, at least 200.");
    await expect(open).toBeDisabled();
    await expect(open).toHaveAttribute("title", "Whole CKB, at least 200.");

    // A new amount applies at once, with no restart: the figures follow it, and it is saved.
    await field.fill("49,000");
    await expect(panel.getByTestId("fiber-node-hub-total")).toHaveText("Needs 49,001 CKB on chain · you have 1,300 CKB");
    await expect(panel.getByTestId("fiber-node-hub-pay-note")).toContainText("A new channel lets it pay 48,901 CKB at once.");
    await expect(panel.getByTestId("fiber-node-hub-short")).toHaveText("Not enough CKB on chain. Add 47,701 CKB first.");
    await expect(open).toBeDisabled();
    expect(await page.evaluate(() => localStorage.getItem("ckbolt:fiber-browser:testnet:channel-contribution"))).toBe("49000");
    await expect(panel).not.toContainText(/restart/i);
    expect((await fake(page)).starts).toHaveLength(1);

    // Funded: Max offers all the node holds but the fee margin, and the request goes out with the amount typed.
    h.rpc.balance = ckb(50_000);
    await page.getByRole("button", { name: "Refresh balance" }).click();
    await expect(open).toBeEnabled();
    await panel.getByRole("button", { name: "Max" }).click();
    await expect(field).toHaveValue("49999");
    await field.fill("49000");
    await open.click();
    await expect(hubSummary(page)).toHaveText("Channel asked for. It reads Ready after a few confirmations.");
    // The hub's open reached the node one try late: accept_channel again, with the hub's temporary id and 49,000 CKB.
    const accepts = await callsOf(page, "accept_channel");
    expect(h.hub.inboundTemporaryIds).toHaveLength(1);
    expect(accepts).toEqual(Array(2).fill({ temporary_channel_id: h.hub.inboundTemporaryIds[0], funding_amount: `0x${ckb(49_000).toString(16)}` }));
    expect((await fake(page)).starts).toHaveLength(1);
    // The channel shows as opening: its row rests, and the field goes with it.
    await expect(hubRow(page, "CKB")).toHaveAttribute("data-status", "opening");
    await expect(panel.getByTestId("fiber-node-contribution")).toHaveCount(0);

    // The choice outlives the page.
    await page.reload();
    await expect(page.getByLabel("Your node puts in")).toHaveValue("49000");
  });

  test("a hub channel the node cannot accept says why on its row, and the next row, a token channel, needs no accept", async ({ page, context }) => {
    test.setTimeout(120_000);
    const h = await harness(context, (_hub, rpc) => {
      rpc.balance = ckb(1_400);
    });
    await runningNode(page, { failAccept: "Failed to build funding transaction: insufficient capacity" });
    const panel = hubPanel(page);
    await hubBox(page, "CKB").check();
    await hubBox(page, "RUSD").check();
    await hubOpen(page).click();
    await expect(hubSummary(page)).toHaveText("1 of 2 channels asked for. See the failed row.");
    await expect(panel.getByTestId("fiber-node-hub-reason-CKB")).toHaveText(
      "Your node could not accept the hub's channel: Failed to build funding transaction: insufficient capacity",
    );
    expect(await callsOf(page, "accept_channel")).toHaveLength(1);
    // RUSD: fnn accepts it by its UDT whitelist with nothing from the node.
    await expect(hubRow(page, "RUSD")).toHaveAttribute("data-status", "done");
    expect(h.hub.sent("POST /v1/fiber/inbound-channels").map((r) => (r.body as { asset: string }).asset)).toEqual(["CKB", "RUSD"]);
  });

  test("asks the hub for inbound liquidity with only the node's public id; shows the hub's refusals", async ({ page, context }) => {
    test.setTimeout(90_000);
    const h = await harness(context, (_hub, rpc) => {
      rpc.balance = ckb(1_300);
    });
    await runningNode(page);
    const nodeId = (await fake(page)).nodeId!;
    const panel = hubPanel(page);
    await expect(await openTip(panel, "About the channel with the hub")).toContainText("For CKB your node also puts in the CKB you choose");
    await page.keyboard.press("Escape");

    await hubBox(page, "CKB").check();
    await hubOpen(page).click();
    await expect(hubSummary(page)).toHaveText("Channel asked for. It reads Ready after a few confirmations.");
    expect(h.hub.sent("POST /v1/fiber/inbound-channels").map((r) => r.body)).toEqual([{ nodeId, asset: "CKB" }]);
    expect(nodeId).toMatch(/^0[23][0-9a-f]{64}$/);

    h.hub.inboundAnswers.push({ status: 409, body: apiError("conflict", "Your node already has a RUSD channel from the hub, open or opening.") });
    await hubBox(page, "RUSD").check();
    await hubOpen(page).click();
    await expect(panel.getByTestId("fiber-node-hub-reason-RUSD")).toHaveText("Your node already has a RUSD channel from the hub, open or opening.");
    h.hub.inboundAnswers.push({ status: 429, body: apiError("rate_limited", "This node asked for inbound channels too often today. Try again tomorrow.") });
    await hubBox(page, "RUSD").check();
    await hubOpen(page).click();
    await expect(panel.getByTestId("fiber-node-hub-reason-RUSD")).toHaveText("This node asked for inbound channels too often today. Try again tomorrow.");
    expect(h.hub.sent("POST /v1/fiber/inbound-channels").map((r) => r.body)).toEqual([
      { nodeId, asset: "CKB" },
      { nodeId, asset: "RUSD" },
      { nodeId, asset: "RUSD" },
    ]);

    // With a CKB channel from the hub already, that row rests.
    await setChannels(page, [rpcChannel({ local: ckb(0), remote: ckb(1_000) })]);
    await panel.getByRole("button", { name: "Refresh channels" }).click();
    await expect(hubRow(page, "CKB")).toHaveAttribute("data-status", "open");
    await expect(hubBox(page, "CKB")).toBeDisabled();
  });

  test("a hub that opens no inbound channels says so, and nothing is asked", async ({ page, context }) => {
    test.setTimeout(90_000);
    const h = await harness(context, (hub) => {
      hub.fiberNode.inbound = { enabled: false, amounts: {} };
    });
    await runningNode(page);
    await expect(hubPanel(page)).toContainText("This hub does not open inbound channels to visitors' nodes.");
    await expect(hubOpen(page)).toHaveCount(0);
    await expect(hubPanel(page).getByRole("button", { name: "About the channel with the hub" })).toHaveCount(0);
    expect(h.hub.sent("POST /v1/fiber/inbound-channels")).toEqual([]);
  });

  test("dials the hub's next address when one fails, and offers a retry when all fail", async ({ page, context }) => {
    test.setTimeout(90_000);
    await harness(context);
    await openNodePage(page, { failConnect: ["hub.example.test"] });
    await hubKnown(page);
    await createNode(page);
    await expect(hubPanel(page)).toContainText("Connected");
    expect(await callsOf(page, "connect_peer")).toEqual([{ address: `${HUB_WSS}/p2p/${HUB_PEER_ID}` }, { address: `${HUB_WS}/p2p/${HUB_PEER_ID}` }]);

    const other = await context.newPage();
    await openNodePage(other, { failConnect: ["/"] });
    await page.close();
    await lockFreed(other);
    await hubKnown(other);
    await unlock(other);
    await expect(other.getByTestId("fiber-node-address")).toBeVisible({ timeout: 30_000 });
    const panel = hubPanel(other);
    await expect(panel).toContainText("Not connected");
    await expect(panel).toContainText(`Failed to dial ${HUB_WS}/p2p/${HUB_PEER_ID}`);
    await expect(hubOpen(other)).toBeDisabled();
    await expect(panel.getByTestId("fiber-node-hub-blocked")).toHaveText("Connect to the hub first.");
    await setFake(other, { failConnect: [] });
    await panel.getByRole("button", { name: "Connect to the hub" }).click();
    await expect(panel).toContainText("Connected");
  });

  test("a hub that lists no WebSocket address (TCP only) says the page cannot reach it, and dials nothing", async ({ page, context }) => {
    test.setTimeout(90_000);
    await harness(context, (hub) => {
      hub.fiberNode.addresses = { p2p: ["/ip4/127.0.0.1/tcp/8228"], ws: [] };
    });
    await openNodePage(page);
    await hubKnown(page);
    await createNode(page);
    const panel = hubPanel(page);
    await expect(panel).toContainText("No WebSocket address this page can dial");
    await expect(panel).toContainText("The hub lists no WebSocket address this page can dial.");
    await expect(panel).toContainText("Not connected");
    expect(await callsOf(page, "connect_peer")).toEqual([]);
    expect((await fake(page)).starts[0].config).toContain("bootnode_addrs: []");
  });

  test("an unreachable hub leaves the node running without the hub, until it answers again", async ({ page, context }) => {
    test.setTimeout(90_000);
    const h = await harness(context, (hub) => {
      hub.fail("GET /v1/fiber/node", 503, apiError("hub_unavailable", "Live swaps are not set up on this server."));
    });
    await openNodePage(page);
    const panel = hubPanel(page);
    await expect(panel).toContainText("Live swaps are not set up on this server.");
    await expect(panel).toContainText("The node still runs, but without channels from the hub.");
    await createNode(page);
    expect(await callsOf(page, "connect_peer")).toEqual([]);
    expect((await fake(page)).starts[0].config).toContain("bootnode_addrs: []");

    h.hub.heal("GET /v1/fiber/node");
    await panel.getByRole("button", { name: "Try again" }).click();
    await expect(panel).toContainText("Connected");
    expect(await callsOf(page, "connect_peer")).toEqual([{ address: `${HUB_WSS}/p2p/${HUB_PEER_ID}` }]);
  });

  test("a hub on another CKB network (mainnet) is never dialled and offers nothing", async ({ page, context }) => {
    test.setTimeout(90_000);
    const h = await harness(context, (hub) => {
      hub.fiberNode.network = "mainnet";
    });
    await openNodePage(page);
    await expect(page.getByTestId("fiber-node-hub-network")).toHaveText(
      "The CKBolt hub runs on CKB mainnet; this node runs on CKB testnet. No channels are possible.",
    );
    await createNode(page);
    await expect(page.getByTestId("fiber-node-status")).toContainText("Node id");
    expect(await callsOf(page, "connect_peer")).toEqual([]);
    expect((await fake(page)).starts[0].config).toContain("bootnode_addrs: []");
    await expect(hubPanel(page).getByRole("button")).toHaveText(["Refresh channels"]);
    expect(h.hub.requests.filter((r) => r.key.startsWith("POST"))).toEqual([]);
  });

  test("Fund this node opens the funding page, not isolated, with the node's address in the funding form", async ({ page, context }) => {
    test.setTimeout(90_000);
    await harness(context);
    await runningNode(page);
    const address = (await page.getByTestId("fiber-node-address").locator("p.font-mono").textContent())!.trim();
    expect(address).toMatch(/^ckt1/);
    await expect(page.getByTestId("fiber-node-fund")).toHaveAttribute("href", `/app/fiber/fund?address=${address}`);
    await expect(page.getByTestId("fiber-node-fund")).toHaveAttribute("target", "_blank");
    const [fundPage] = await Promise.all([context.waitForEvent("page"), page.getByTestId("fiber-node-fund").click()]);
    await fundPage.waitForLoadState();
    expect(new URL(fundPage.url()).pathname).toBe("/app/fiber/fund");
    expect(new URL(fundPage.url()).searchParams.get("address")).toBe(address);
    await expect(fundPage.getByRole("heading", { name: "Fund your Fiber node." })).toBeVisible({ timeout: 20_000 });
    await expect(fundPage.getByTestId("fund-node-address")).toContainText(address);
    // The shared "Fund my Fiber node" form, for that address, with its own wallet connector.
    const form = fundPage.getByTestId("fund-fiber-node");
    await expect(form).toBeVisible({ timeout: 20_000 });
    await expect(form.getByRole("button", { name: "Connect CKB wallet" })).toBeVisible();
    await expect(fundPage.getByTestId("fund-node-missing")).toHaveCount(0);
    // Wallet popups (JoyID) need a page that is not isolated.
    expect(await fundPage.evaluate(() => crossOriginIsolated)).toBe(false);
    // The node tab keeps running: the funding page runs no node and takes no lock.
    await expect(page.getByTestId("fiber-node-status")).toContainText("Node id");
    await fundPage.close();
  });

  test("the funding page without a CKB testnet address funds nothing and points back to the node page", async ({ page }) => {
    const mainnet = ccc.Address.from({ script: { codeHash: SECP_CODE_HASH, hashType: "type", args: `0x${"ab".repeat(20)}` }, prefix: "ckb" }).toString();
    for (const path of [`/app/fiber/fund?address=${mainnet}`, "/app/fiber/fund?address=hello", "/app/fiber/fund"]) {
      await page.goto(path);
      const missing = page.getByTestId("fund-node-missing");
      await expect(missing, path).toBeVisible({ timeout: 20_000 });
      await expect(missing).toContainText("This link has no CKB testnet node address.");
      await expect(missing.getByRole("link", { name: "Open your Fiber node" })).toHaveAttribute("href", "/app/fiber");
      await expect(page.getByTestId("fund-fiber-node")).toHaveCount(0);
      await expect(page.locator("main")).not.toContainText(mainnet);
    }
  });

  test("the funding page fits the screen and has no serious accessibility problems", async ({ page }) => {
    const address = ccc.Address.from({ script: { codeHash: SECP_CODE_HASH, hashType: "type", args: `0x${"cd".repeat(20)}` }, prefix: "ckt" }).toString();
    await page.goto(`/app/fiber/fund?address=${address}`);
    await expect(page.getByTestId("fund-fiber-node")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Testnet: fund your browser Fiber node")).toBeVisible();
    await expect(page.locator("main")).toContainText("Send test CKB from your wallet to your browser node.");
    await expect(await openTip(page, "About this page")).toContainText("wallet popups do not work on the isolated node page");
    await page.keyboard.press("Escape");
    await expectNoHorizontalOverflow(page);
    const results = await new AxeBuilder({ page }).include("[data-testid=fund-node-page]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 5).join(", ")}`)).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------ getting the CKB back */

/** A plain wallet's lock on CKB testnet, and its address; `prefix` "ckb" writes the same lock as a mainnet address. */
function walletAddress(prefix: "ckt" | "ckb" = "ckt") {
  const lock: Script = { codeHash: SECP_CODE_HASH, hashType: "type", args: `0x${randomBytes(20).toString("hex")}` };
  return { lock, address: ccc.Address.from({ script: lock, prefix }).toString() };
}

/** The node's own lock and address, from the fake node (the lock of its CKB key). */
async function nodeOwn(page: Page) {
  const lock: Script = { codeHash: SECP_CODE_HASH, hashType: "type", args: (await fake(page)).lockArgs! };
  return { lock, address: ccc.Address.from({ script: lock, prefix: "ckt" }).toString() };
}

const rpcScript = (s: Script) => ({ code_hash: s.codeHash, hash_type: s.hashType, args: s.args });

test.describe("browser Fiber node: getting the CKB back", () => {
  test("closes the hub's channel to the visitor's wallet: the address goes to fnn as close_script; another network or the node's own address is refused", async ({ page, context }) => {
    test.setTimeout(90_000);
    await harness(context);
    await runningNode(page, { channels: [rpcChannel({ local: ckb(401), remote: ckb(0) })] });
    const opened = (await fake(page)).channels[0];
    const row = page.getByTestId("fiber-node-channels").locator("tbody tr").first();
    await row.getByRole("button", { name: "Close" }).click();
    const confirm = page.getByTestId("fiber-node-close-confirm");
    await expect(confirm).toContainText("Close the CKB channel with the CKBolt hub?");
    expect(await (await openTip(confirm, "About closing to your wallet")).textContent()).toContain("fnn pays the node's share of the channel straight to this address");
    await page.keyboard.press("Escape");

    await confirm.getByRole("radio", { name: /^My wallet/ }).click();
    await expect(confirm.getByRole("radio", { name: /^My wallet/ })).toHaveAttribute("aria-checked", "true");
    const field = confirm.getByLabel("Your CKB testnet address");
    const yes = confirm.getByRole("button", { name: "Yes, close" });
    await expect(yes).toBeDisabled();

    await field.fill(walletAddress("ckb").address);
    await expect(confirm).toContainText("This address is not on CKB testnet. Use a CKB testnet address (ckt1…), like the node's.");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(yes).toBeDisabled();
    await field.fill((await nodeOwn(page)).address);
    await expect(confirm).toContainText("This is the node's own address. Paste your wallet's address.");
    await expect(yes).toBeDisabled();
    await field.fill("ckt1 not an address");
    await expect(yes).toBeDisabled();

    const wallet = walletAddress();
    await field.fill(` ${wallet.address} `);
    await expect(field).toHaveAttribute("aria-invalid", "false");
    await yes.click();
    await expect(page.getByTestId("fiber-node-hub-notice")).toHaveText(
      `Closing the channel cooperatively. Its share goes to ${shorten(wallet.address, 12)} once confirmed.`,
    );
    expect(await callsOf(page, "shutdown_channel")).toEqual([{ channel_id: opened.channel_id, close_script: rpcScript(wallet.lock) }]);
    await expect(row).toContainText("Closing");
  });

  test("the connected CKB wallet gives its address in one click, for a close (it signs nothing here)", async ({ page, context }) => {
    test.setTimeout(120_000);
    const h = await harness(context, (_hub, rpc) => {
      rpc.chain = new FakeCkbChain();
    });
    const wallet = await installCkbWallet(page);
    await runningNode(page, { channels: [rpcChannel({ local: ckb(401), remote: ckb(0) })] });
    const opened = (await fake(page)).channels[0];
    await page.getByTestId("fiber-node-channels").locator("tbody tr").first().getByRole("button", { name: "Close" }).click();
    const confirm = page.getByTestId("fiber-node-close-confirm");
    await confirm.getByRole("radio", { name: /^My wallet/ }).click();
    // Popup wallets cannot connect on this isolated page: the "?" says what to do instead.
    expect(await (await openTip(confirm, "About wallets on this page")).textContent()).toContain("JoyID and other wallets that open a popup cannot open where the node runs.");
    await page.keyboard.press("Escape");
    // The connector loads with the field, then the button connects a wallet and fills its address.
    await confirm.getByRole("button", { name: "Connect CKB wallet" }).click({ timeout: 30_000 });
    await chooseUtxoGlobal(page);
    await expect(confirm.getByLabel("Your CKB testnet address")).toHaveValue(wallet.address, { timeout: 15_000 });
    await expect(confirm.getByRole("button", { name: "Use UTXO Global Wallet" })).toBeVisible();
    await confirm.getByRole("button", { name: "Yes, close" }).click();
    expect(await callsOf(page, "shutdown_channel")).toEqual([{ channel_id: opened.channel_id, close_script: rpcScript(wallet.lock) }]);
    // The wallet was asked for nothing to sign, and its address went to no web service (only into the node's call).
    expect(wallet.signRequests).toEqual([]);
    expect(h.sent.filter((r) => `${r.url}\n${r.body}`.includes(wallet.address)).map((r) => r.url)).toEqual([]);
  });

  test("withdraws all the node's on-chain CKB with its password: one transaction to the visitor's address, minus the fee; nothing secret leaves the page", async ({ page, context }) => {
    test.setTimeout(120_000);
    const h = await harness(context, (_hub, rpc) => {
      rpc.chain = new FakeCkbChain();
    });
    await runningNode(page);
    const chain = h.rpc.chain!;
    const node = await nodeOwn(page);
    const cells = [chain.addCell({ lock: node.lock, capacity: ckb(600) }), chain.addCell({ lock: node.lock, capacity: ckb(150) })];
    await page.getByRole("button", { name: "Refresh balance" }).click();
    await expect(page.getByTestId("fiber-node-status")).toContainText("750 CKB");

    await page.getByTestId("fiber-node-withdraw-open").click();
    const form = page.getByTestId("fiber-node-withdraw");
    await expect(form.getByTestId("fiber-node-withdraw-amount")).toHaveText("Sends all 750 CKB, minus a small fee.");
    await expect(form).toContainText("CKB in open channels is not included: close them first.");
    expect(await (await openTip(form, "About withdrawing")).textContent()).toContain("The page opens the node key with your password to sign it, then wipes it.");
    await page.keyboard.press("Escape");
    const submit = form.getByRole("button", { name: "Withdraw 750 CKB" });
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveAttribute("title", "Enter your CKB testnet address first.");

    // Only a CKB testnet address that is not the node's own; and the node's password.
    const field = form.getByLabel("To your CKB testnet address");
    await field.fill(walletAddress("ckb").address);
    await expect(form).toContainText("This address is not on CKB testnet.");
    await field.fill(node.address);
    await expect(form).toContainText("This is the node's own address. Paste your wallet's address.");
    const wallet = walletAddress();
    await field.fill(wallet.address);
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveAttribute("title", "Enter the node password.");
    const password = form.getByLabel("Node password");
    await password.fill("not the password");
    await submit.click();
    await expect(form.getByTestId("fiber-node-withdraw-error")).toHaveText("Wrong password, or the stored node key was changed.");
    await expect(password).toHaveAttribute("aria-invalid", "true");
    expect(chain.sent).toEqual([]);

    await password.fill(PASSWORD);
    await submit.click();
    const done = page.getByTestId("fiber-node-withdraw-sent");
    await expect(done).toBeVisible({ timeout: 30_000 });
    expect(chain.sent).toHaveLength(1);
    const tx = chain.sent[0];
    // One output, to the visitor's address, holding all of the node's plain cells but the fee.
    expect(tx.outputs).toHaveLength(1);
    expect(sameScript(tx.outputs[0].lock, wallet.lock)).toBe(true);
    const amount = BigInt(tx.outputs[0].capacity);
    const fee = ckb(750) - amount;
    expect(fee).toBeGreaterThan(BigInt(0));
    expect(fee).toBeLessThan(ckb(1) / BigInt(100));
    expect(tx.inputs.map((i) => i.previous_output.tx_hash).sort()).toEqual(cells.map((c) => c.txHash).sort());
    // Signed with the node's key, in the page.
    expect(tx.witnesses[0].length).toBeGreaterThan(2 + 130);
    const hash = rpcTransactionHash(tx);
    await expect(done.getByRole("status")).toHaveText(
      `Sent ${ccc.fixedPointToString(amount)} CKB to ${shorten(wallet.address, 12)}. It arrives once the transaction confirms.`,
    );
    await expect(done).toContainText(`${ccc.fixedPointToString(fee)} CKB`);
    await expect(done).toContainText(shorten(hash, 10));
    const explorer = done.getByRole("link", { name: "View on CKB Explorer (testnet)" });
    await expect(explorer).toHaveAttribute("href", `https://testnet.explorer.nervos.org/transaction/${hash}`);
    await expect(explorer).toHaveAttribute("target", "_blank");

    // The keys and the password stayed in the page; only the signed transaction went out.
    const start = (await fake(page)).starts[0];
    await expectNowhere([start.fiberKey, start.ckbKey!, PASSWORD], [{ name: "requests", text: requestsText(h) }]);
    expect(h.hub.requests.map((r) => r.key).filter((k) => !k.startsWith("GET "))).toEqual([]);
    await done.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("fiber-node-withdraw-open")).toBeVisible();
  });

  test("withdraws a token the node holds on chain: all of it to the visitor's address, its cells' CKB back to the node, exact token only", async ({ page, context }) => {
    test.setTimeout(120_000);
    const TYPE_ID = "0x00000000000000000000000000000000000000000000000000545950455f4944";
    const CODE_TYPE_ID_ARGS = `0x${"97".repeat(32)}`;
    const udtData = (units: bigint): string => ccc.hexFrom(ccc.numLeToBytes(units, 16));
    const h = await harness(context, (hub, rpc) => {
      rpc.chain = new FakeCkbChain();
      // The hub's whitelist entry for RUSD: its code is the cell that carries this Type ID.
      hub.fiberNode.assets[1] = {
        ...hub.fiberNode.assets[1]!,
        udtWhitelist: { name: "RUSD", script: RUSD_SCRIPT, cellDeps: [{ typeId: { codeHash: TYPE_ID, hashType: "type", args: CODE_TYPE_ID_ARGS } }], autoAcceptAmount: null },
      };
    });
    await runningNode(page);
    const chain = h.rpc.chain!;
    const node = await nodeOwn(page);
    const code = chain.addCell({ lock: walletAddress().lock, capacity: ckb(5_000), type: { codeHash: TYPE_ID, hashType: "type", args: CODE_TYPE_ID_ARGS }, data: "0x00" });
    const rusd = [
      chain.addCell({ lock: node.lock, capacity: ckb(143), type: RUSD_SCRIPT, data: udtData(ckb(20)) }),
      chain.addCell({ lock: node.lock, capacity: ckb(143), type: RUSD_SCRIPT, data: udtData(ckb(5)) }),
    ];
    // Another token whose args start with RUSD's: the indexer's prefix match returns it too, the node must not.
    const decoy = chain.addCell({ lock: node.lock, capacity: ckb(143), type: { ...RUSD_SCRIPT, args: `${RUSD_SCRIPT.args}00000000` }, data: udtData(ckb(7)) });
    chain.addCell({ lock: node.lock, capacity: ckb(600) });
    await page.getByRole("button", { name: "Refresh balance" }).click();

    await page.getByTestId("fiber-node-withdraw-open").click();
    const form = page.getByTestId("fiber-node-withdraw");
    const choice = form.getByTestId("fiber-node-withdraw-asset");
    await expect(choice.getByRole("radio")).toHaveText(["CKB", "RUSD"]);
    await choice.getByRole("radio", { name: "RUSD" }).click();
    await expect(form.getByTestId("fiber-node-withdraw-amount")).toHaveText("Sends all 25 RUSD. The node pays the fee in CKB.");
    await expect(form).toContainText("Withdraw on-chain RUSD");
    await expect(form).toContainText("Tokens in open channels are not included: close them first.");
    const wallet = walletAddress();
    await form.getByLabel("To your CKB testnet address").fill(wallet.address);
    await form.getByLabel("Node password").fill(PASSWORD);
    await form.getByRole("button", { name: "Withdraw 25 RUSD" }).click();

    const done = page.getByTestId("fiber-node-withdraw-sent");
    await expect(done).toBeVisible({ timeout: 30_000 });
    expect(chain.sent).toHaveLength(1);
    const tx = chain.sent[0];
    // All 25 RUSD in one cell to the visitor's address; the decoy stays where it was.
    expect(sameScript(tx.outputs[0].lock, wallet.lock)).toBe(true);
    expect(sameScript(tx.outputs[0].type!, RUSD_SCRIPT)).toBe(true);
    expect(tx.outputs_data[0]).toBe(udtData(ckb(25)));
    const spent = tx.inputs.map((i) => i.previous_output.tx_hash);
    for (const cell of rusd) expect(spent).toContain(cell.txHash);
    expect(spent).not.toContain(decoy.txHash);
    // The token's code, found by its Type ID, is a cell dep.
    expect(tx.cell_deps.map((d) => d.out_point.tx_hash)).toContain(code.txHash);
    // Everything else goes back to the node as plain CKB.
    for (const output of tx.outputs.slice(1)) {
      expect(sameScript(output.lock, node.lock)).toBe(true);
      expect(output.type ?? null).toBeNull();
    }
    await expect(done.getByRole("status")).toHaveText(`Sent 25 RUSD to ${shorten(wallet.address, 12)}. It arrives once the transaction confirms.`);
  });

  test("offers no token choice while the node holds none on chain: the CKB form as before", async ({ page, context }) => {
    test.setTimeout(120_000);
    const h = await harness(context, (_hub, rpc) => {
      rpc.chain = new FakeCkbChain();
    });
    await runningNode(page);
    h.rpc.chain!.addCell({ lock: (await nodeOwn(page)).lock, capacity: ckb(600) });
    await page.getByRole("button", { name: "Refresh balance" }).click();
    await page.getByTestId("fiber-node-withdraw-open").click();
    const form = page.getByTestId("fiber-node-withdraw");
    await expect(form.getByTestId("fiber-node-withdraw-amount")).toHaveText("Sends all 600 CKB, minus a small fee.");
    await expect(form.getByTestId("fiber-node-withdraw-asset")).toHaveCount(0);
  });

  test("refuses to withdraw while a channel opens or closes, also when one starts right before signing", async ({ page, context }) => {
    test.setTimeout(120_000);
    const h = await harness(context, (_hub, rpc) => {
      rpc.chain = new FakeCkbChain();
    });
    const opening = rpcChannel({ local: ckb(0), remote: ckb(1_000), state: "AwaitingChannelReady" });
    await runningNode(page, { channels: [opening] });
    const chain = h.rpc.chain!;
    chain.addCell({ lock: (await nodeOwn(page)).lock, capacity: ckb(600) });
    await page.getByRole("button", { name: "Refresh balance" }).click();
    await page.getByTestId("fiber-node-withdraw-open").click();
    const form = page.getByTestId("fiber-node-withdraw");
    await form.getByLabel("To your CKB testnet address").fill(walletAddress().address);
    await form.getByLabel("Node password").fill(PASSWORD);
    const submit = form.getByRole("button", { name: "Withdraw 600 CKB" });
    await expect(form.getByTestId("fiber-node-withdraw-blocked")).toHaveText("A channel is opening or closing. Withdraw once it is done.");
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveAttribute("title", "A channel is opening or closing. Withdraw once it is done.");

    // Ready: the withdrawal may go (the channel's own CKB stays in it).
    await setChannels(page, [{ ...opening, state: { state_name: "ChannelReady" } }]);
    await expect(form.getByTestId("fiber-node-withdraw-blocked")).toHaveCount(0, { timeout: 15_000 });
    await expect(submit).toBeEnabled();

    // A channel starts closing between the page's last read and the click: the page reads again and signs nothing.
    const reads = (await callsOf(page, "list_channels")).length;
    await expect.poll(async () => (await callsOf(page, "list_channels")).length, { timeout: 15_000 }).toBeGreaterThan(reads);
    await setChannels(page, [{ ...opening, state: { state_name: "ShuttingDown" } }]);
    await submit.click();
    await expect(form.getByTestId("fiber-node-withdraw-error")).toHaveText("A channel is opening or closing. Withdraw once it is done.");
    expect(chain.sent).toEqual([]);
    expect(chain.count("get_cells")).toBe(0);
  });

  test("with the close and withdraw forms open: no serious axe finding, nothing wider than the screen", async ({ page, context }) => {
    test.setTimeout(90_000);
    await harness(context);
    await runningNode(page, { channels: [rpcChannel({ local: ckb(401), remote: ckb(0) })] });
    await page.getByTestId("fiber-node-channels").locator("tbody tr").first().getByRole("button", { name: "Close" }).click();
    await page.getByTestId("fiber-node-close-confirm").getByRole("radio", { name: /^My wallet/ }).click();
    await page.getByTestId("fiber-node-withdraw-open").click();
    await expect(page.getByTestId("fiber-node-withdraw")).toBeVisible();
    await expectNoSeriousAxe(page, "main");
    await expectNoHorizontalOverflow(page);
  });
});

/* ------------------------------------------------------------------------------------------- the bridge */

test.describe("browser Fiber node: the bridge", () => {
  test("a node page whose hub runs on another CKB network refuses swap requests sent straight over the bridge", async ({ page, context }) => {
    test.setTimeout(90_000);
    const h = await harness(context, (hub) => {
      hub.fiberNode.network = "mainnet";
      hub.health.fiber.network = "mainnet";
    });
    await openNodePage(page, { channels: [rpcChannel({ local: ckb(10_000), remote: ckb(10_000) })] });
    await expect(page.getByTestId("fiber-node-hub-network")).toBeVisible({ timeout: 20_000 });
    await createNode(page);

    // A fiber_to_ln swap of that hub, waiting for its payment, with its (mainnet) hold invoice.
    const now = Date.now();
    const swapId = randomUUID();
    const holdInvoice = demoFiberInvoice("mainnet", ckb(8_000));
    h.hub.swap = {
      id: swapId,
      quoteId: randomUUID(),
      direction: "fiber_to_ln",
      asset: "CKB",
      state: "pending",
      paymentHash: randomBytes(32).toString("hex"),
      pay: { network: "fiber", asset: "CKB", amount: ckb(8_000).toString(), decimals: 8, invoice: holdInvoice },
      receive: { network: "lightning", asset: "BTC", amount: "19800", decimals: 8, invoice: lightningInvoice(19_800) },
      refunded: false,
      failureReason: null,
      preimage: null,
      demo: false,
      quoteExpiresAt: new Date(now + 150_000).toISOString(),
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      links: { self: `/v1/swaps/${swapId}`, events: `/v1/swaps/${swapId}/events` },
    };

    // Any page of the site can talk on the bridge; the node tab must still refuse, not only the swap form.
    const app = await context.newPage();
    await app.goto("/app");
    const ask = (method: string, params: unknown) =>
      app.evaluate(
        ({ name, version, method, params }) =>
          new Promise<{ ok?: boolean; error?: { code: string }; timeout?: boolean }>((resolve) => {
            const channel = new BroadcastChannel(name);
            const id = crypto.randomUUID();
            const timer = setTimeout(() => {
              channel.close();
              resolve({ timeout: true });
            }, 15_000);
            channel.onmessage = (event) => {
              const data = event.data as { kind?: string; id?: string; ok?: boolean; error?: { code: string } };
              if (data?.kind !== "response" || data.id !== id) return;
              clearTimeout(timer);
              channel.close();
              resolve(data);
            };
            channel.postMessage({ v: version, kind: "request", id, method, params });
          }),
        { name: BRIDGE_CHANNEL_NAME, version: BRIDGE_PROTOCOL_VERSION, method, params },
      );

    const paid = await ask("pay-invoice", { swapId, invoice: holdInvoice });
    expect.soft(paid, "pay-invoice answer").toMatchObject({ ok: false, error: { code: "wrong_network" } });
    const made = await ask("make-invoice", { asset: "CKB", amount: ckb(100).toString(), quoteExpiresAt: new Date(now + 150_000).toISOString(), network: null });
    expect.soft(made, "make-invoice answer").toMatchObject({ ok: false, error: { code: "wrong_network" } });
    expect.soft(await callsOf(page, "send_payment"), "send_payment calls").toEqual([]);
    expect.soft(await callsOf(page, "new_invoice"), "new_invoice calls").toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------- layout, a11y */

test.describe("browser Fiber node: layout and accessibility", () => {
  test("the running node page fits the screen and has no serious accessibility problems", async ({ page, context }) => {
    test.setTimeout(90_000);
    await harness(context);
    await runningNode(page, { channels: [rpcChannel({ local: ckb(401), remote: ckb(150) })] });
    await expect(page.getByTestId("fiber-node-channels")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const results = await new AxeBuilder({ page }).include("[data-testid=fiber-node]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 5).join(", ")}`)).toEqual([]);
  });
});
