import { randomBytes } from "node:crypto";
import { expect, type BrowserContext, type Page, type Route } from "@playwright/test";
import { demoFiberInvoice } from "../../../lib/payment-request";
import type { FiberNodeAssetDto, FiberNodeDto, Script, UdtWhitelistDto } from "../../../lib/hub/contract";
import { TEST_FIBER_NODE_GLOBAL } from "../../../lib/wallets/fiber-browser/fiber-test-hook";
import { peerIdOf } from "../../../lib/wallets/fiber-browser/peer-id";

/*
 * The visitor's browser Fiber node for Playwright: the real /app/fiber page (keys, keystore, Web Lock, bridge) with
 * fiber-js replaced by the page's documented test hook `window.__ckboltTestFiberNode`
 * (lib/wallets/fiber-browser/fiber-loader.ts). The stand-in answers like fnn 0.9.1 and records every call. It is the
 * same stand-in as tests/e2e/fiber-browser.spec.ts uses, kept here so other specs can open a running node next to /app.
 * The hub's Fiber node (GET /v1/fiber/node) and the public CKB RPC are answered by ./live-hub.ts and FakeCkbRpc below.
 */

/* --------------------------------------------------------------------------------------------- fixtures */

export const NODE_PASSWORD = "testnet node pass";
/** A real testnet node (bottle) stands in for the hub's node, so its tentacle peer id is known. */
const HUB_NODE_ID = "02b6d4e3ab86a2ca2fad6fae0ecb2e1e559e0b911939872a90abdda6d20302be71";
const HUB_WSS = "/dns4/hub.example.test/tcp/443/wss";
const HUB_WS = "/ip4/127.0.0.1/tcp/8229/ws";
/** The RUSD token's type script on CKB testnet, as the hub lists it. */
export const RUSD_SCRIPT: Script = {
  codeHash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hashType: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
/** RUSD's whitelist entry as the hub sends it (GET /v1/fiber/node): its xUDT code cell by type id, auto-accepted at 20 RUSD. */
export const RUSD_WHITELIST: UdtWhitelistDto = {
  name: "RUSD",
  script: RUSD_SCRIPT,
  cellDeps: [
    {
      typeId: {
        codeHash: "0x00000000000000000000000000000000000000000000000000545950455f4944",
        hashType: "type",
        args: "0x97d30b723c0b2c66e9cb8d4d0df4ab5d7222cbb00d4a9a2055ce2e5d7f0d8b0f",
      },
    },
  ],
  autoAcceptAmount: "2000000000",
};
/** cWBTC (CCH Wrapped BTC) on CKB testnet: an xUDT whose args carry 4 more bytes than RUSD's. */
export const CWBTC_SCRIPT: Script = {
  codeHash: "0x25c29dc317811a6f6f3985a7a9ebc4838bd388d19d0feeecf0bcd60f6c0975bb",
  hashType: "type",
  args: "0x9a1086531ed6dc69e0bd44cef5278e03faf3015b31aff60b08fb87663ce8507100000000",
};
/** cWBTC's whitelist entry as the hub sends it: its code cell by out point, auto-accepted at 10 cWBTC. */
export const CWBTC_WHITELIST: UdtWhitelistDto = {
  name: "cWBTC",
  script: CWBTC_SCRIPT,
  cellDeps: [{ outPoint: { txHash: "0xbf6fb538763efec2a70a6a3dcb7242787087e1030c4e7d86585bc63a9d337f5f", index: "0x0" }, depType: "code" }],
  autoAcceptAmount: "1000000000",
};
/** cWBTC in GET /v1/fiber/node's `assets`, and what the hub funds an inbound cWBTC channel with (10 cWBTC). */
export const CWBTC_FIBER_ASSET: FiberNodeAssetDto = { id: "CWBTC", udtTypeScript: CWBTC_SCRIPT, udtWhitelist: CWBTC_WHITELIST, peerChannels: null };
export const CWBTC_INBOUND_AMOUNT = "1000000000";
/** cWBTC's peerChannels as the hub on testnet-vps serves it (docs/add-token.md): one faucet claim, 0.01 cWBTC, at least. */
export const CWBTC_PEER_CHANNELS = { minAmount: "1000000", assumedCommitmentDelayEpochs: 84 } as const;
/** The public CKB testnet RPC the node page reads its balance from. */
const CKB_RPC = "https://testnet.ckbapp.dev/";
const SHANNONS = BigInt(100_000_000);
/** Whole CKB (or RUSD, also 8 decimals) in base units. */
export const units = (whole: number): bigint => BigInt(whole) * SHANNONS;
const hexQ = (n: bigint) => `0x${n.toString(16)}`;
/** What the funded node holds on CKB L1, so its page has a balance to show. */
const NODE_L1_BALANCE_CKB = 600;

/** The hub's Fiber node as GET /v1/fiber/node reports it. */
export const HUB_FIBER_NODE: FiberNodeDto = {
  nodeId: HUB_NODE_ID,
  network: "testnet",
  addresses: { p2p: ["/ip4/127.0.0.1/tcp/8228"], ws: [HUB_WSS, HUB_WS] },
  assets: [
    { id: "CKB", udtTypeScript: null, udtWhitelist: null, peerChannels: null },
    { id: "RUSD", udtTypeScript: RUSD_SCRIPT, udtWhitelist: RUSD_WHITELIST, peerChannels: null },
  ],
  inbound: { enabled: true, amounts: { CKB: "100000000000", RUSD: "2000000000" } },
};

/* ----------------------------------------------------------------------------------------- CKB RPC fake */

/** The amount of a UDT cell (xUDT, sUDT): 16 bytes, little endian, as get_cells' output_data carries it. */
const udtData = (amount: bigint): string => {
  let hex = "";
  for (let i = 0, v = amount; i < 16; i++, v >>= BigInt(8)) hex += Number(v & BigInt(0xff)).toString(16).padStart(2, "0");
  return `0x${hex}`;
};

/** The public CKB testnet RPC the node page reads its balance from (with CORS, as the real one answers). */
export class FakeCkbRpc {
  balance = units(NODE_L1_BALANCE_CKB);
  /**
   * The node's token cells by the token's type script args (lower case): each amount is one cell, as get_cells lists
   * them for the lock with the type script as its filter. A token with none answers no cells.
   */
  tokenCells: Record<string, bigint[]> = {};
  /** get_cells answers an RPC error (the token balance cannot be read). */
  failTokenReads = false;
  /** The methods the page asked for, in order. */
  readonly methods: string[] = [];

  async install(context: BrowserContext) {
    await context.route(`${CKB_RPC}**`, (route) => this.handle(route));
  }

  private async handle(route: Route) {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS" };
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const body = request.postDataJSON?.() ?? {};
    this.methods.push(String(body.method));
    const answer =
      body.method === "get_cells_capacity"
        ? { jsonrpc: "2.0", id: body.id, result: { capacity: hexQ(this.balance), block_hash: `0x${"00".repeat(32)}`, block_number: "0x1" } }
        : body.method === "get_cells"
          ? this.cells(body)
          : { jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32601, message: "Method not found" } };
    return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(answer) });
  }

  /** get_cells with a type script filter, as the indexer answers it: the node's cells of that token, on one page. */
  private cells(body: { id?: number; params?: unknown[] }) {
    if (this.failTokenReads) return { jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32000, message: "Indexer is busy" } };
    const [key, , , cursor] = (body.params ?? []) as [{ script?: unknown; filter?: { script?: { args?: string } } }, string, string, string | null];
    const args = key?.filter?.script?.args?.toLowerCase() ?? "";
    // One page: a cursor asks for the next, which is empty.
    const amounts = cursor ? [] : (this.tokenCells[args] ?? []);
    const objects = amounts.map((amount, i) => ({
      // At the node's lock, of the token asked for: the page counts only cells of exactly both (ckb-rpc.ts tokenAmount).
      output: { capacity: hexQ(units(143)), lock: key?.script ?? null, type: key?.filter?.script ?? null },
      output_data: udtData(amount),
      out_point: { tx_hash: `0x${"cd".repeat(32)}`, index: hexQ(BigInt(i)) },
      block_number: "0x1",
      tx_index: "0x0",
    }));
    return { jsonrpc: "2.0", id: body.id ?? 1, result: { objects, last_cursor: objects.length > 0 ? "0xpage1" : "0x" } };
  }
}

/* ------------------------------------------------------------------------------------------- fake node */

interface FakeRpcScript {
  code_hash: string;
  hash_type: string;
  args: string;
}

export interface FakeChannel {
  channel_id: string;
  is_public: boolean;
  pubkey: string;
  funding_udt_type_script: FakeRpcScript | null;
  state: { state_name: string };
  local_balance: string;
  remote_balance: string;
  enabled: boolean;
}

export interface FakeNodeOptions {
  /** The window property the page reads (TEST_FIBER_NODE_GLOBAL). */
  globalName: string;
  hubNodeId: string;
  /**
   * The nodes connect_peer can reach, by the tentacle peer id their address names (`/p2p/<id>`), as fnn finds a peer;
   * the hub's is always there. An address naming no known node fails to dial.
   */
  knownPeers: Record<string, string>;
  /** list_peers shows a node this many calls after connect_peer, as fnn lists a peer only once connected (0: at once). */
  peerListDelay: Record<string, number>;
  channels: FakeChannel[];
  /**
   * send_payment's answer once a route is found; `fee` (hex) is what get_payment reports once it succeeded. `throws`
   * fails a real send only (a dry run found the route; sending it then failed).
   */
  sendPayment: { status: string; failedError: string | null; throws: string | null; fee?: string };
  /** The routes send_payment finds, dry run or not (FakeRoutes): by default both work. */
  routes: FakeRoutes;
  /**
   * accept_channel: the hub's open_channel message reaches the node this many accept_channel calls late, as fnn says
   * "No channel with temp id ... found" until it has arrived.
   */
  acceptMisses: number;
  /**
   * The state a channel accepted with accept_channel starts in: "CollaboratingFundingTx" by default (its funding still
   * being built, as fnn right after the accept); "ChannelReady" for a test that does not wait for confirmations.
   */
  acceptedState: string;
  /** accept_channel fails at once with this fnn error message (null: it accepts). */
  failAccept: string | null;
}

/**
 * What fnn's routing finds for a payment: `direct`, without trampoline_hops; `trampoline`, with them. null finds a route;
 * a string is the RPC error fnn throws ("Failed to build route", as for a payee behind a private channel).
 */
export interface FakeRoutes {
  direct: string | null;
  trampoline: string | null;
}

/** fnn's answer for a payee it cannot see: every browser node's channel with the hub is private. */
export const NO_ROUTE_ERROR = "Failed to build route";

interface FakeCall {
  name: string;
  params: Record<string, unknown> | null;
}

/** An entry of the UDT whitelist the node started with, as fnn reads it: `args` is a regex over a script's args. */
interface FakeWhitelistEntry {
  name: string;
  code_hash: string;
  hash_type: string;
  args: string;
  /** Base units from which fnn accepts a channel in the token by itself, or null (it waits for accept_channel). */
  auto_accept_amount: string | null;
}

/** A channel the hub opened in a token, and what the node did with it (fnn: whitelisted and from the auto amount up). */
export interface FakeUdtOpen {
  args: string;
  amount: string;
  outcome: "accepted" | "not_whitelisted" | "waiting";
}

interface FakeNodeState {
  opts: FakeNodeOptions;
  calls: FakeCall[];
  peers: string[];
  /** Nodes dialled but not yet listed: list_peers calls left before they show. */
  pending: Record<string, number>;
  channels: FakeChannel[];
  routes: FakeRoutes;
  invoices: Record<string, { invoice: string; status: string }>;
  payments: Record<string, { invoice: string; status: string; failed_error: string | null; fee: string }>;
  /** The payment hash parse_invoice read in each invoice, so send_payment pays under it, as fnn does. */
  parsed: Record<string, string>;
  nodeId: string | null;
  lockArgs: string | null;
  /** accept_channel calls seen per temporary channel id. */
  acceptTries: Record<string, number>;
  /** The config's UDT whitelist, read when the node started (fnn reads it only then). */
  whitelist: FakeWhitelistEntry[];
  /** The token channels the hub opened to the node, in order, and what it did with each. */
  udtOpens: FakeUdtOpen[];
}

type FakeWindow = { __fakeFiber: FakeNodeState };

/** The page function that makes the fake node's invoices (exposed by the test). */
const INVOICE_BRIDGE = "__testFiberInvoice";
/** The page function that reads an invoice for parse_invoice (exposed by a test that pays Fiber invoices; ./fiber-wallet.ts InvoiceBook). */
const PARSE_BRIDGE = "__testParseFiberInvoice";
/** The page function that derives the CKB lock args of a key, as fnn does (exposed by a test that withdraws). */
const LOCK_ARGS_BRIDGE = "__testCkbLockArgs";

const fakeOptions = (overrides: Partial<FakeNodeOptions> = {}): FakeNodeOptions => {
  const hubNodeId = overrides.hubNodeId ?? HUB_NODE_ID;
  return {
    globalName: TEST_FIBER_NODE_GLOBAL,
    channels: [],
    sendPayment: { status: "Inflight", failedError: null, throws: null },
    routes: { direct: null, trampoline: null },
    peerListDelay: {},
    acceptMisses: 1,
    acceptedState: "CollaboratingFundingTx",
    failAccept: null,
    ...overrides,
    hubNodeId,
    knownPeers: { [peerIdOf(hubNodeId)]: hubNodeId, ...overrides.knownPeers },
  };
};

/** The known-peers entry of a node, for FakeNodeOptions.knownPeers. */
export const knownPeer = (nodeId: string): Record<string, string> => ({ [peerIdOf(nodeId)]: nodeId });

/** A ready channel with the hub: `local` is what the node can send, `remote` what it can receive; RUSD with `udt`. */
export const hubChannel = (o: { local: bigint; remote: bigint; udt?: Script | null; peer?: string; state?: string }): FakeChannel => ({
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
 * lock derive from the keys it is given. Self-contained, because Playwright sends its source to the page.
 */
function fakeNodeScript({ opts, invoiceBridge, parseBridge, lockArgsBridge }: { opts: FakeNodeOptions; invoiceBridge: string; parseBridge: string; lockArgsBridge: string }) {
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
    peers: [],
    pending: {},
    channels: opts.channels.slice(),
    routes: { ...opts.routes },
    invoices: {},
    payments: {},
    parsed: {},
    nodeId: null,
    lockArgs: null,
    acceptTries: {},
    whitelist: [],
    udtOpens: [],
  };
  // fnn's `ckb.udt_whitelist`, read from the config as fnn would: each item's script and auto_accept_amount.
  const readWhitelist = (config: string): FakeWhitelistEntry[] => {
    const lines = config.split("\n");
    const key = lines.findIndex((line) => /^\s+udt_whitelist:\s*$/.test(line));
    if (key < 0) return [];
    const keyIndent = lines[key].search(/\S/);
    const out: FakeWhitelistEntry[] = [];
    let item: FakeWhitelistEntry | null = null;
    let inScript = false;
    const value = (line: string) => line.slice(line.indexOf(":") + 1).replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
    for (const line of lines.slice(key + 1)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const indent = line.search(/\S/);
      if (indent < keyIndent || (indent === keyIndent && !line.trim().startsWith("-"))) break;
      const text = line.trim().replace(/^-\s+/, "");
      if (line.trim().startsWith("- ") && /^name:/.test(text)) {
        item = { name: value(text), code_hash: "", hash_type: "", args: "", auto_accept_amount: null };
        out.push(item);
        inScript = false;
        continue;
      }
      if (!item) continue;
      if (/^script:\s*$/.test(text)) inScript = true;
      else if (/^(cell_deps|auto_accept_amount):/.test(text)) inScript = false;
      if (/^auto_accept_amount:/.test(text)) item.auto_accept_amount = value(text);
      if (inScript && /^(code_hash|hash_type|args):/.test(text)) item[text.slice(0, text.indexOf(":")) as "code_hash" | "hash_type" | "args"] = value(text);
    }
    return out;
  };
  const listPeer = (pubkey: string) => {
    if (!state.peers.includes(pubkey)) state.peers.push(pubkey);
    delete state.pending[pubkey];
  };
  const w = window as unknown as Record<string, unknown>;
  w.__fakeFiber = state;
  w[opts.globalName] = {
    getDefaultConfig(network: string, url: string) {
      // As fiber-js 0.9.1's bundled testnet config: its TCP bootnode, and RUSD as the one whitelisted token.
      return [
        "fiber:",
        '  listening_addr: "/ip4/0.0.0.0/tcp/8228"',
        "  bootnode_addrs:",
        '    - "/ip4/54.179.226.154/tcp/8228/p2p/Qmes1EBD4yNo9Ywkfe6eRw9tG1nVNGLDmMud1xJMsoYFKy"',
        "  announce_listening_addr: true",
        `  chain: ${network}`,
        "ckb:",
        `  rpc_url: "${url}"`,
        "  udt_whitelist:",
        "    - name: RUSD",
        "      script:",
        "        code_hash: 0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
        "        hash_type: type",
        "        args: 0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
        "      cell_deps:",
        "        - type_id:",
        "            code_hash: 0x00000000000000000000000000000000000000000000000000545950455f4944",
        "            hash_type: type",
        "            args: 0x97d30b723c0b2c66e9cb8d4d0df4ab5d7222cbb00d4a9a2055ce2e5d7f0d8b0f",
        "      auto_accept_amount: 1000000000",
        "",
        "services:",
        "  - fiber",
        "  - rpc",
        "  - ckb",
      ].join("\n");
    },
    async start(config: string, fiberKey: Uint8Array, ckbKey?: Uint8Array) {
      state.whitelist = readWhitelist(config);
      const fiberCopy = fiberKey.slice();
      const ckbCopy = ckbKey ? ckbKey.slice() : new Uint8Array(32);
      state.nodeId = "02" + (await sha(fiberCopy));
      // As fnn: the secp256k1-blake160 lock of the CKB key when the test can compute it (so the page can sign for it).
      const lockArgsOf = w[lockArgsBridge] as ((key: string) => Promise<string>) | undefined;
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
            // What the node page's diagnostics copy (fnn 0.9.1's node_info fields).
            commit_hash: "0d1e2f3",
            chain_hash: "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606",
            open_channel_auto_accept_min_ckb_funding_amount: "0x9502f9000",
            // The browser node accepts every CKB channel itself: its config turns fnn's auto-accept off.
            auto_accept_channel_ckb_funding_amount: "0x0",
            tlc_expiry_delta: "0xdbba00",
            tlc_min_value: "0x0",
            tlc_fee_proportional_millionths: "0x3e8",
            udt_cfg_infos: [],
          };
        case "connect_peer": {
          // As fnn: the address names the node by its peer id; the node is listed once connected.
          const address = String(p.address);
          const pubkey = state.opts.knownPeers[/\/p2p\/([^/]+)/.exec(address)?.[1] ?? ""];
          if (!pubkey) throw rpcError(`Failed to dial ${address}`);
          if (state.peers.includes(pubkey) || pubkey in state.pending) return null;
          const delay = state.opts.peerListDelay[pubkey] ?? 0;
          if (delay <= 0) listPeer(pubkey);
          else state.pending[pubkey] = delay;
          return null;
        }
        case "list_peers":
          for (const pubkey of Object.keys(state.pending)) {
            state.pending[pubkey]--;
            if (state.pending[pubkey] <= 0) listPeer(pubkey);
          }
          return { peers: state.peers.map((pubkey) => ({ pubkey, address: "/ip4/127.0.0.1/tcp/8229/ws" })) };
        case "list_channels":
          return { channels: state.channels };
        case "open_channel": {
          // As fnn: only with a connected peer that has sent its Init.
          if (!state.peers.includes(String(p.pubkey))) throw rpcError("waiting for peer to send Init message");
          // As fnn: a channel in a token only when the node's own whitelist (read at start) names the token.
          const udt = p.funding_udt_type_script as FakeRpcScript | undefined;
          if (udt) {
            const args = String(udt.args).toLowerCase();
            const listed = state.whitelist.some(
              (e) => e.code_hash.toLowerCase() === String(udt.code_hash).toLowerCase() && e.hash_type === udt.hash_type && new RegExp(e.args).test(args),
            );
            if (!listed) throw rpcError("Invalid UDT type script");
          }
          const id = "0x" + randomHex(32);
          state.channels.push({
            channel_id: id,
            is_public: p.public === true,
            pubkey: String(p.pubkey),
            funding_udt_type_script: (p.funding_udt_type_script as FakeRpcScript | undefined) ?? null,
            state: { state_name: "NegotiatingFunding" },
            local_balance: String(p.funding_amount),
            remote_balance: "0x0",
            enabled: true,
          });
          return { temporary_channel_id: id };
        }
        case "accept_channel": {
          // As fnn 0.9.1: the opener's open_channel must have arrived; then the channel starts under its final id.
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
            state: { state_name: state.opts.acceptedState },
            local_balance: String(p.funding_amount),
            remote_balance: "0x0",
            enabled: true,
          });
          return { channel_id: id };
        }
        case "shutdown_channel": {
          const found = state.channels.find((c) => c.channel_id === p.channel_id);
          if (!found) throw rpcError("Channel not found");
          found.state = { state_name: "ShuttingDown" };
          return null;
        }
        case "parse_invoice": {
          // As fnn: an invoice it cannot read is an error; one it reads keeps its payment hash.
          const parse = w[parseBridge] as ((invoice: string) => Promise<unknown>) | undefined;
          const parsed = (parse ? await parse(String(p.invoice)) : null) as { data: { payment_hash: string } } | null;
          if (!parsed) throw rpcError("Invalid invoice");
          state.parsed[String(p.invoice)] = parsed.data.payment_hash;
          return { invoice: parsed };
        }
        case "new_invoice": {
          const paymentHash = "0x" + (await sha(unhex(String(p.payment_preimage))));
          const invoice = await (w[invoiceBridge] as (amount: string) => Promise<string>)(String(p.amount));
          state.invoices[paymentHash] = { invoice, status: "Open" };
          return { invoice_address: invoice, invoice: { currency: p.currency, amount: p.amount, data: { payment_hash: paymentHash, attrs: [] } } };
        }
        case "get_invoice": {
          const found = state.invoices[String(p.payment_hash)];
          if (!found) throw rpcError("Invoice not found");
          return { invoice_address: found.invoice, invoice: { data: { payment_hash: p.payment_hash } }, status: found.status };
        }
        case "cancel_invoice": {
          // As fnn 0.9.1: an invoice nobody paid (Open, or past its expiry) is cancelled; once a payment arrived (a
          // regular invoice keeps its preimage), or it is paid or cancelled already, it is refused.
          const found = state.invoices[String(p.payment_hash)];
          if (!found) throw rpcError("Invoice not found");
          if (found.status === "Paid") throw rpcError("Invoice already paid");
          if (found.status === "Cancelled") throw rpcError("Invoice already cancelled");
          if (found.status === "Received") throw rpcError("Payment preimage already exists");
          found.status = "Cancelled";
          return { invoice_address: found.invoice, invoice: { data: { payment_hash: p.payment_hash } }, status: found.status };
        }
        case "send_payment": {
          const behaviour = state.opts.sendPayment;
          // As fnn: trampoline_hops needs max_fee_amount; the route is built first (no route: an RPC error).
          const hops = Array.isArray(p.trampoline_hops) ? p.trampoline_hops : [];
          if (hops.length > 0 && p.max_fee_amount === undefined) throw rpcError("max_fee_amount is required when trampoline_hops is set");
          const noRoute = hops.length > 0 ? state.routes.trampoline : state.routes.direct;
          if (noRoute) throw rpcError(noRoute);
          const invoice = String(p.invoice ?? "");
          const paymentHash = state.parsed[invoice] ?? "0x" + randomHex(32);
          // A dry run builds the route and fee and keeps no payment session, as fnn.
          if (p.dry_run === true) return { payment_hash: paymentHash, status: "Created", failed_error: null, fee: behaviour.fee ?? "0x0" };
          if (behaviour.throws) throw rpcError(behaviour.throws);
          // As fnn: one session per payment hash, refused again while it is not Failed.
          const known = state.payments[paymentHash];
          if (known && known.status !== "Failed") throw rpcError(`Payment session already exists: ${paymentHash}`);
          const fee = behaviour.fee ?? "0x0";
          state.payments[paymentHash] = { invoice, status: behaviour.status, failed_error: behaviour.failedError, fee };
          return { payment_hash: paymentHash, status: behaviour.status, failed_error: behaviour.failedError, fee: behaviour.status === "Success" ? fee : "0x0" };
        }
        case "get_payment": {
          const found = state.payments[String(p.payment_hash)];
          if (!found) throw rpcError("Payment session not found");
          return { payment_hash: p.payment_hash, status: found.status, failed_error: found.failed_error, fee: found.status === "Success" ? found.fee : "0x0" };
        }
        default:
          throw new TypeError(`fiber.default.${name} is not a function`);
      }
    },
    async stop() {
      // Nothing runs in the stand-in.
    },
  };
}

/** Where the node runs: a page (the node page, a wallet window) or a frame (the header's wallet popup). */
export type NodeScope = Pick<Page, "evaluate">;

/** The calls the fake node received, by fiber-js command name, with their parameters. */
export const nodeCalls = (scope: NodeScope, name: string): Promise<(Record<string, unknown> | null)[]> =>
  scope.evaluate((command) => (window as unknown as FakeWindow).__fakeFiber.calls.filter((c) => c.name === command).map((c) => c.params), name);

/** The real send_payment calls (Pay's dry runs left out): what fnn was asked to pay. */
export const nodeSends = async (scope: NodeScope): Promise<(Record<string, unknown> | null)[]> =>
  (await nodeCalls(scope, "send_payment")).filter((params) => params?.dry_run !== true);

/** Pay's dry runs of send_payment: the routes it tried, without paying. */
export const nodeDryRuns = async (scope: NodeScope): Promise<(Record<string, unknown> | null)[]> =>
  (await nodeCalls(scope, "send_payment")).filter((params) => params?.dry_run === true);

/** The invoices the fake node made, in order. */
export const nodeInvoices = (scope: NodeScope): Promise<string[]> =>
  scope.evaluate(() => Object.values((window as unknown as FakeWindow).__fakeFiber.invoices).map((i) => i.invoice));

/** The payment hash (0x) of the invoice the fake node made as `invoice` (its text), or null. */
export const nodeInvoiceHash = (scope: NodeScope, invoice: string): Promise<string | null> =>
  scope.evaluate(
    (text) => Object.entries((window as unknown as FakeWindow).__fakeFiber.invoices).find(([, made]) => made.invoice === text)?.[0] ?? null,
    invoice,
  );

/**
 * BTC to CKB or RUSD: the real hub's hold invoice carries the payment hash of the payout invoice the node made, so both
 * legs share it; the fake draws its own, so a test that follows the swap into the node's History takes the node's (the
 * swap's hash and its hold invoice, support/live-hub.ts `useNodeHash`).
 */
export async function shareNodeHash(hub: { current: { receive: { invoice: string } }; useNodeHash(hash: string): void }, scope: NodeScope): Promise<string> {
  const hash = await nodeInvoiceHash(scope, hub.current.receive.invoice);
  if (!hash) throw new Error("the node made no invoice for this swap");
  hub.useNodeHash(hash);
  return hash;
}

/**
 * The hub opens a channel in a token to the node (its open_channel arrives), as fnn takes it: refused when the token is
 * not in the whitelist the node started with; accepted by itself, all the funding on the hub's side, when the hub funds
 * at least the entry's auto_accept_amount; otherwise left waiting for an accept_channel the app never sends for a token.
 */
export const deliverHubUdtChannel = (scope: NodeScope, o: { udt: Script; amount: string; state?: string }): Promise<FakeUdtOpen> =>
  scope.evaluate(({ udt, amount, channelState }) => {
    const s = (window as unknown as FakeWindow).__fakeFiber;
    const args = udt.args.toLowerCase();
    const entry = s.whitelist.find((e) => e.code_hash.toLowerCase() === udt.codeHash.toLowerCase() && e.hash_type === udt.hashType && new RegExp(e.args).test(args));
    const outcome: FakeUdtOpen["outcome"] = !entry
      ? "not_whitelisted"
      : entry.auto_accept_amount !== null && BigInt(amount) >= BigInt(entry.auto_accept_amount)
        ? "accepted"
        : "waiting";
    const open = { args: udt.args, amount, outcome };
    s.udtOpens.push(open);
    if (outcome === "accepted") {
      s.channels.push({
        channel_id: `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")}`,
        is_public: false,
        pubkey: s.opts.hubNodeId,
        funding_udt_type_script: { code_hash: udt.codeHash, hash_type: udt.hashType, args: udt.args },
        state: { state_name: channelState },
        local_balance: "0x0",
        remote_balance: `0x${BigInt(amount).toString(16)}`,
        enabled: true,
      });
    }
    return open;
  }, { udt: o.udt, amount: o.amount, channelState: o.state ?? "ChannelReady" });

/** The UDT whitelist the fake node started with: each token's name and args pattern. */
export const nodeWhitelist = (scope: NodeScope): Promise<{ name: string; args: string; autoAccept: string | null }[]> =>
  scope.evaluate(() => (window as unknown as FakeWindow).__fakeFiber.whitelist.map((e) => ({ name: e.name, args: e.args, autoAccept: e.auto_accept_amount })));

/** The fake node's own id and lock args, once it started. */
export const nodeIdentity = (scope: NodeScope): Promise<{ nodeId: string | null; lockArgs: string | null }> =>
  scope.evaluate(() => {
    const s = (window as unknown as FakeWindow).__fakeFiber;
    return { nodeId: s.nodeId, lockArgs: s.lockArgs };
  });

/** Changes the routes the fake node's send_payment finds from now on. */
export const setNodeRoutes = (scope: NodeScope, routes: FakeRoutes): Promise<void> =>
  scope.evaluate((next) => {
    (window as unknown as FakeWindow).__fakeFiber.routes = next;
  }, routes);

/** Changes the fake node's options from now on (accept_channel's answer, the state an accepted channel starts in). */
export const setNodeOptions = (scope: NodeScope, patch: Partial<Pick<FakeNodeOptions, "acceptedState" | "failAccept" | "acceptMisses">>): Promise<void> =>
  scope.evaluate((next) => {
    Object.assign((window as unknown as FakeWindow).__fakeFiber.opts, next);
  }, patch);

/** Every channel of the fake node still opening becomes ready, as fnn once its funding has its confirmations. */
export const confirmNodeChannels = (scope: NodeScope): Promise<void> =>
  scope.evaluate(() => {
    for (const c of (window as unknown as FakeWindow).__fakeFiber.channels) {
      if (c.state.state_name !== "ShuttingDown" && c.state.state_name !== "Closed") c.state = { state_name: "ChannelReady" };
    }
  });

/** Replaces the fake node's channels. */
export const setNodeChannels = (scope: NodeScope, channels: FakeChannel[]): Promise<void> =>
  scope.evaluate((list) => {
    (window as unknown as FakeWindow).__fakeFiber.channels = list;
  }, channels);

/** Moves every invoice (or payment) the fake node holds to `status`, as fnn would once it is paid. */
export const settleNodeInvoices = (scope: NodeScope, status: string): Promise<void> =>
  scope.evaluate((next) => {
    for (const invoice of Object.values((window as unknown as FakeWindow).__fakeFiber.invoices)) invoice.status = next;
  }, status);

/** Moves the one invoice the fake node made as `invoice` (its text) to `status`, as fnn would once a payer paid it. */
export const settleNodeInvoice = (scope: NodeScope, invoice: string, status: string): Promise<void> =>
  scope.evaluate(
    ([text, next]) => {
      for (const made of Object.values((window as unknown as FakeWindow).__fakeFiber.invoices)) if (made.invoice === text) made.status = next;
    },
    [invoice, status] as const,
  );

export const settleNodePayments = (scope: NodeScope, status: string, failedError: string | null = null): Promise<void> =>
  scope.evaluate(
    ([next, error]) => {
      for (const payment of Object.values((window as unknown as FakeWindow).__fakeFiber.payments)) {
        payment.status = next as string;
        payment.failed_error = error;
      }
    },
    [status, failedError] as const,
  );

/** The fake node's payments by payment hash: the invoice each paid and its status (fnn's payment sessions). */
export const nodePayments = (scope: NodeScope): Promise<Record<string, { invoice: string; status: string }>> =>
  scope.evaluate(() => {
    const out: Record<string, { invoice: string; status: string }> = {};
    for (const [hash, p] of Object.entries((window as unknown as FakeWindow).__fakeFiber.payments)) out[hash] = { invoice: p.invoice, status: p.status };
    return out;
  });

/**
 * Installs the fake node on every page the context opens from now on, so a node tab opened from the swap card's "Open
 * Fiber node" link runs it too. Its invoices are Fiber testnet invoices for the amount asked.
 */
export async function installFakeNode(context: BrowserContext, options: Partial<FakeNodeOptions> = {}) {
  await context.exposeFunction(INVOICE_BRIDGE, (amountHex: string) => demoFiberInvoice("testnet", BigInt(amountHex)));
  await context.addInitScript(fakeNodeScript, {
    opts: fakeOptions(options),
    invoiceBridge: INVOICE_BRIDGE,
    parseBridge: PARSE_BRIDGE,
    lockArgsBridge: LOCK_ARGS_BRIDGE,
  });
}

/* ------------------------------------------------------------------------------------------- node page */

/** How long the node page may take to render, create keys (scrypt) and reach the hub, on a cold dev server. */
const NODE_PAGE_TIMEOUT_MS = 30_000;

const hubPanel = (page: Page) => page.getByTestId("fiber-node-hub");

/**
 * Creates the node on an open /app/fiber page (a fresh browser, so no keystore yet) and waits until it runs and is
 * connected to the hub's node. The page must already know the hub's node, so it starts with the hub as its bootnode.
 */
export async function createRunningNode(page: Page) {
  await expect(page.getByTestId("fiber-node-key")).toBeVisible({ timeout: NODE_PAGE_TIMEOUT_MS });
  await expect(hubPanel(page)).toContainText("Hub node", { timeout: NODE_PAGE_TIMEOUT_MS });
  await page.getByLabel("Password, at least 8 characters").fill(NODE_PASSWORD);
  await page.getByLabel("Repeat the password").fill(NODE_PASSWORD);
  await page.getByRole("button", { name: "Create node" }).click();
  await expect(page.getByTestId("fiber-node-address")).toBeVisible({ timeout: NODE_PAGE_TIMEOUT_MS });
  await expect(hubPanel(page)).toContainText("Connected", { timeout: NODE_PAGE_TIMEOUT_MS });
}

/** Opens /app/fiber in a new tab of `context` (installFakeNode first) and leaves a running, hub-connected node in it. */
export async function openRunningNode(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/app/fiber");
  await createRunningNode(page);
  return page;
}
