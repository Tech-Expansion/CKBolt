import { createHash } from "node:crypto";
import { FIBER_CHANNEL_READY_STATE } from "../../../src/common/constants/fiber-rpc.constants";
import { CKB_GENESIS_HASH } from "../../../src/common/constants/protocol.constants";
import type { AssetDto, FiberNodeDto, HealthDto } from "../../../src/interfaces/http/contract/responses";
import type { BlockchainInfo } from "../../scripts/lib/bitcoind";
import type { FnnChannel, FnnPayment, FnnPeer, FnnScript } from "../../scripts/lib/fiber";
import type { LndChannel, LndPendingChannel } from "../../scripts/lib/lnd";
import type { CommandResult } from "../../scripts/lib/process";
import { FakeRunner, result, shellWords, TEST_REMOTE_DIR, withoutKitDir, type RecordedCall } from "./fakes";

/**
 * A simulated server for the deploy scripts: the kit folder's files, docker compose (services, containers, ports), two
 * LND nodes answering lncli, two fnn nodes answering JSON-RPC through curl, bitcoind, and the hub's REST API through
 * curl. Each fake records what it was asked; tests change the state to build a scenario.
 */

export const PUBKEY = {
  LND_HUB: `02${"a1".repeat(32)}`,
  LND_DEMO: `03${"b2".repeat(32)}`,
  LSP: "03e30fda71887a916ef5548a4d02b06fe04aaa1a8de9e24134ce7f139cf79d7579",
  FNN_HUB: `02${"c3".repeat(32)}`,
  FNN_DEMO: `03${"d4".repeat(32)}`,
  BOTTLE: "02b6d4e3ab86a2ca2fad6fae0ecb2e1e559e0b911939872a90abdda6d20302be71",
  BRACER: "0291a6576bd5a94bd74b27080a48340875338fff9f6d6361fe6b8db8d0d1912fcc",
} as const;

export const PEER_ID = { FNN_HUB: "QmHubPeerId1111111111111111111111111111111111", FNN_DEMO: "QmDemoPeerId222222222222222222222222222222222" } as const;

/** A secp256k1 lock like fnn's default funding lock (args differ per node). */
export const lockOf = (args: string): FnnScript => ({
  code_hash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
  hash_type: "type",
  args,
});

const hex = (value: bigint): string => `0x${value.toString(16)}`;
const fail = (stderr: string, exitCode = 1): CommandResult => result("", exitCode, stderr);

/* ------------------------------------------------------------------------------------------------------- LND */

export class FakeLnd {
  state: string | null = "SERVER_ACTIVE";
  confirmed = 0n;
  unconfirmed = 0n;
  channels: LndChannel[] = [];
  pending: LndPendingChannel[] = [];
  peers: string[] = [];
  synced = true;
  blockHeight = 2_000_000;
  uris: string[] = [];
  /** On-chain fee each funding or send transaction costs. */
  feeSats = 250n;
  readonly calls: string[][] = [];
  private addressCount = 0;
  /** lncli payinvoice: by default the payment succeeds and prints one JSON object. */
  pay: (bolt11: string, args: string[]) => CommandResult = (bolt11) =>
    result(JSON.stringify({ payment_hash: createHash("sha256").update(bolt11).digest("hex"), status: "SUCCEEDED", payment_preimage: "ee".repeat(32), failure_reason: "FAILURE_REASON_NONE", fee_sat: "1" }));

  constructor(
    readonly service: string,
    readonly pubkey: string,
  ) {}

  handle(args: string[]): CommandResult {
    this.calls.push(args);
    const [subcommand, ...rest] = args;
    const flag = (name: string): string | undefined => rest.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
    switch (subcommand) {
      case "state":
        return this.state === null ? fail("[lncli] rpc error: code = Unavailable desc = connection refused") : result(JSON.stringify({ state: this.state }));
      case "getinfo":
        return result(
          JSON.stringify({
            identity_pubkey: this.pubkey,
            alias: this.service,
            synced_to_chain: this.synced,
            block_height: this.blockHeight,
            num_peers: this.peers.length,
            num_active_channels: this.channels.filter((channel) => channel.active).length,
            num_pending_channels: this.pending.length,
            chains: [{ chain: "bitcoin", network: "signet" }],
            uris: this.uris,
          }),
        );
      case "walletbalance":
        return result(JSON.stringify({ confirmed_balance: this.confirmed.toString(), unconfirmed_balance: this.unconfirmed.toString() }));
      case "newaddress":
        this.addressCount += 1;
        return result(JSON.stringify({ address: `tb1p${this.service.replace("-", "")}${this.addressCount}` }));
      case "listchannels":
        return result(JSON.stringify({ channels: this.channels }));
      case "pendingchannels":
        return result(JSON.stringify({ pending_open_channels: this.pending }));
      case "listpeers":
        return result(JSON.stringify({ peers: this.peers.map((pub_key) => ({ pub_key })) }));
      case "connect": {
        const pubkey = (rest[0] ?? "").split("@")[0] ?? "";
        if (this.peers.includes(pubkey)) return fail(`[lncli] rpc error: code = Unknown desc = already connected to peer: ${rest[0]}`);
        this.peers.push(pubkey);
        return result("{\n\n}");
      }
      case "openchannel": {
        const peer = flag("node_key") ?? "";
        const sats = BigInt(flag("local_amt") ?? "0");
        const push = BigInt(flag("push_amt") ?? "0");
        if (push >= sats) return fail("[lncli] rpc error: code = Unknown desc = amount pushed to remote peer for initial state must be below the local funding amount");
        if (this.confirmed < sats + this.feeSats) return fail("[lncli] rpc error: code = Unknown desc = not enough witness outputs to create funding transaction");
        this.confirmed -= sats + this.feeSats;
        const balances = { local_balance: (sats - push).toString(), remote_balance: push.toString() };
        this.pending.push({ channel: { remote_node_pub: peer, capacity: sats.toString(), ...balances } });
        return result(JSON.stringify({ funding_txid: `f${"0".repeat(63)}` }));
      }
      case "sendcoins": {
        const sats = BigInt(flag("amt") ?? "0");
        if (this.confirmed < sats + this.feeSats) return fail("[lncli] rpc error: code = Unknown desc = insufficient funds available to construct transaction");
        this.confirmed -= sats + this.feeSats;
        return result(JSON.stringify({ txid: `a${"0".repeat(63)}` }));
      }
      case "payinvoice":
        return this.pay(rest[rest.length - 1] ?? "", rest);
      case "bakemacaroon":
        return result("");
      default:
        return fail(`fake lncli: unknown command ${subcommand}`);
    }
  }

  /** Commands that change the node (open, send, pay, connect, new address, macaroon). */
  mutatingCalls(): string[][] {
    const readOnly = ["state", "getinfo", "walletbalance", "listchannels", "pendingchannels", "listpeers"];
    return this.calls.filter((call) => !readOnly.includes(call[0] ?? ""));
  }
}

export const lndChannel = (remote: string, local: bigint, remoteBalance: bigint, active = true): LndChannel => ({
  remote_pubkey: remote,
  active,
  initiator: true,
  capacity: (local + remoteBalance).toString(),
  local_balance: local.toString(),
  remote_balance: remoteBalance.toString(),
  channel_point: `${"c".repeat(64)}:0`,
});

/* ------------------------------------------------------------------------------------------------------- fnn */

export interface RpcCall {
  method: string;
  params: unknown[];
}

export class FakeFnn {
  chainHash: string = CKB_GENESIS_HASH.testnet;
  version = "0.9.1";
  addresses: string[];
  peers: FnnPeer[] = [];
  channels: FnnChannel[] = [];
  readonly calls: RpcCall[] = [];
  readonly invoiceStatus = new Map<string, string>();
  readonly payments = new Map<string, FnnPayment>();
  /** connect_peer: which pubkey answers at an address (a peer the node can reach). */
  reachable = new Map<string, string>();
  /** Per-method overrides: a result, or an Error for a JSON-RPC error. */
  overrides: Record<string, (params: unknown[]) => unknown> = {};

  constructor(
    readonly service: string,
    readonly pubkey: string,
    readonly lock: FnnScript,
    addresses: string[] = [],
  ) {
    this.addresses = addresses;
  }

  handle(input: string): CommandResult {
    const request = JSON.parse(input) as { id: number; method: string; params: unknown[] };
    this.calls.push({ method: request.method, params: request.params });
    try {
      const answer = this.answer(request.method, request.params);
      return result(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: answer }));
    } catch (error) {
      return result(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: (error as Error).message } }));
    }
  }

  private answer(method: string, params: unknown[]): unknown {
    const override = this.overrides[method];
    if (override) {
      const value = override(params);
      if (value instanceof Error) throw value;
      return value;
    }
    const first = (params[0] ?? {}) as Record<string, unknown>;
    switch (method) {
      case "node_info":
        return { version: this.version, pubkey: this.pubkey, addresses: this.addresses, chain_hash: this.chainHash, default_funding_lock_script: this.lock };
      case "list_peers":
        return { peers: this.peers };
      case "connect_peer": {
        const pubkey = this.reachable.get(String(first.address));
        if (pubkey && !this.peers.some((peer) => peer.pubkey === pubkey)) this.peers.push({ pubkey, address: String(first.address) });
        return null;
      }
      case "list_channels": {
        const pubkey = first.pubkey as string | undefined;
        return { channels: pubkey ? this.channels.filter((channel) => channel.pubkey === pubkey) : this.channels };
      }
      case "open_channel":
        return { temporary_channel_id: `0x${"7".repeat(64)}` };
      case "new_invoice": {
        const preimage = String(first.payment_preimage).replace(/^0x/, "");
        const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
        this.invoiceStatus.set(hash, "Open");
        return { invoice_address: `fibt1${hash}`, invoice: {} };
      }
      case "get_invoice":
        return { status: this.invoiceStatus.get(String(first.payment_hash).replace(/^0x/, "")) ?? "Paid" };
      case "send_payment": {
        const hash = String(first.invoice).replace(/^fibt1/, "");
        return { payment_hash: `0x${hash}`, status: "Created" };
      }
      case "get_payment":
        return this.payments.get(String(first.payment_hash).replace(/^0x/, "")) ?? { payment_hash: first.payment_hash, status: "Success" };
      default:
        throw new Error(`fake fnn: unknown method ${method}`);
    }
  }

  callsOf(method: string): RpcCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  mutatingCalls(): RpcCall[] {
    const readOnly = ["node_info", "list_peers", "list_channels", "get_invoice", "get_payment"];
    return this.calls.filter((call) => !readOnly.includes(call.method));
  }
}

/** A channel as fnn v0.9.1 lists it; its state names are PascalCase ("ChannelReady", checked on the devnet's fnn). */
export const fnnChannel = (pubkey: string, local: bigint, remote: bigint, options: { state?: string; udt?: FnnScript | null } = {}): FnnChannel => ({
  channel_id: `0x${"9".repeat(64)}`,
  pubkey,
  state: { state_name: options.state ?? FIBER_CHANNEL_READY_STATE },
  funding_udt_type_script: options.udt ?? null,
  local_balance: hex(local),
  remote_balance: hex(remote),
  is_public: true,
});

/* ------------------------------------------------------------------------------------------------------- hub */

export interface HubRequest {
  method: string;
  path: string;
  body: unknown;
}

export type HubRoute = (request: HubRequest) => { status: number; body: unknown } | undefined;

export const healthyHealth = (): HealthDto => ({
  status: "ok",
  version: "0.3.0",
  lightning: { reachable: true, network: "signet", synced: true, blockHeight: 2_000_000 },
  fiber: { reachable: true, network: "testnet", version: "0.9.1" },
  demo: { enabled: false },
  swaps: { paused: false },
});

export const ckbAsset = (lightningSats = 300_000n, fiberAmount = 5_000_000_000_000n): AssetDto => ({
  id: "CKB",
  symbol: "CKB",
  name: "CKB",
  displayName: null,
  iconUrl: null,
  decimals: 8,
  directions: ["ln_to_fiber", "fiber_to_ln"],
  minSats: "1000",
  maxSats: "20000",
  liquidity: { lightningSats: lightningSats.toString(), fiberAmount: fiberAmount.toString() },
});

export const fiberNodeView = (ws: string[]): FiberNodeDto => ({
  nodeId: PUBKEY.FNN_HUB,
  network: "testnet",
  addresses: { p2p: ["/ip4/203.0.113.7/tcp/8228"], ws },
  assets: [{ id: "CKB", udtTypeScript: null, udtWhitelist: null, peerChannels: null }],
  inbound: { enabled: true, amounts: { CKB: "200000000000" } },
});

export class FakeHub {
  health: HealthDto | null = healthyHealth();
  healthStatus = 200;
  assets: AssetDto[] = [ckbAsset()];
  fiberNode: FiberNodeDto | null = fiberNodeView([`/ip4/203.0.113.7/tcp/8228/ws/p2p/${PEER_ID.FNN_HUB}`]);
  readonly requests: HubRequest[] = [];
  readonly curlWords: string[][] = [];
  private readonly routes: HubRoute[] = [];

  route(handler: HubRoute): this {
    this.routes.unshift(handler);
    return this;
  }

  handle(words: string[], input: string): CommandResult {
    this.curlWords.push(words);
    const method = words[words.indexOf("-X") + 1] ?? "GET";
    const url = new URL(words[words.length - 1] ?? "");
    const request: HubRequest = { method, path: url.pathname, body: input ? JSON.parse(input) : undefined };
    this.requests.push(request);
    const answer = this.routes.map((route) => route(request)).find((candidate) => candidate !== undefined) ?? this.defaultAnswer(request);
    return result(`${answer.body === undefined ? "" : JSON.stringify(answer.body)}\n${answer.status}`);
  }

  private defaultAnswer({ method, path }: HubRequest): { status: number; body: unknown } {
    if (method === "GET" && path === "/v1/health") return { status: this.healthStatus, body: this.health };
    if (method === "GET" && path === "/v1/assets") return { status: 200, body: { data: this.assets } };
    if (method === "GET" && path === "/v1/fiber/node") {
      return this.fiberNode ? { status: 200, body: this.fiberNode } : { status: 404, body: { error: { code: "not_found", message: "no route" } } };
    }
    return { status: 404, body: { error: { code: "not_found", message: `no fake route for ${method} ${path}` } } };
  }
}

/* ------------------------------------------------------------------------------------------------ deployment */

export interface ContainerState {
  State: string;
  Health: string;
  Publishers: { URL: string; TargetPort: number; PublishedPort: number }[];
}

/** The image the kit's compose file gives the hub with the default HUB_IMAGE_TAG. */
export const HUB_IMAGE = "ckbolt/hub:local";
const HUB_ACTIVE = ["bitcoind", "lnd-hub", "fnn-hub", "hub"];
const DEMO_ACTIVE = ["bitcoind", "lnd-hub", "lnd-demo", "fnn-hub", "fnn-demo", "hub"];

export class FakeDeployment {
  readonly dir = TEST_REMOTE_DIR;
  readonly runner = new FakeRunner();
  active: string[];
  containers = new Map<string, ContainerState>();
  files = new Set<string>(["docker-compose.yml", ".env", "hub.env", ".env.example", "hub.env.example"]);
  composeVersion: string | null = "2.33.1";
  tools = new Set(["curl", "ss"]);
  listening = "";
  takeoverOutput = `volume-present\n/ckbolt-testnet-bitcoind-1|bitcoind|true|/data\n`;
  /** `docker compose config --format json`: services, their images and their published ports. */
  config: { services: Record<string, { image?: unknown; ports?: { published?: string; host_ip?: string }[]; environment?: Record<string, string> }> } = {
    services: {
      bitcoind: {},
      "lnd-hub": { ports: [{ published: "9735" }] },
      "fnn-hub": { ports: [{ published: "8228" }] },
      hub: { image: HUB_IMAGE, ports: [{ published: "18787", host_ip: "127.0.0.1" }] },
    },
  };
  /** Images present on the server (`docker image inspect <image>` exits 0 only for these). */
  images = new Set<string>([HUB_IMAGE]);
  /** `python3 add_token.py <args>` in the kit folder: by default it finds nothing to write. Tests replace it. */
  addToken: (args: string[]) => CommandResult = () => result("FIBER_ASSETS: RUSD  ->  RUSD\nnothing to write, no backup made\n");
  /** The arguments of every add_token.py run. */
  readonly addTokenRuns: string[][] = [];
  bitcoind: BlockchainInfo = {
    chain: "signet",
    blocks: 2_000_000,
    headers: 2_000_000,
    verificationprogress: 0.99999,
    initialblockdownload: false,
    size_on_disk: 9_800_000_000,
  };
  hubPort = "127.0.0.1:18787";
  readonly lnd: { "lnd-hub": FakeLnd; "lnd-demo": FakeLnd };
  readonly fnn: { "fnn-hub": FakeFnn; "fnn-demo": FakeFnn };
  readonly hub = new FakeHub();
  /** docker compose commands other than reads (up, stop, down, restart, cp, build, logs), as argument lists. */
  readonly composeCommands: string[][] = [];

  constructor(options: { demo?: boolean } = {}) {
    this.active = options.demo ? [...DEMO_ACTIVE] : [...HUB_ACTIVE];
    for (const service of this.active) {
      const publishers =
        service === "hub"
          ? [{ URL: "127.0.0.1", TargetPort: 8787, PublishedPort: 18787 }]
          : service === "lnd-hub"
            ? [{ URL: "0.0.0.0", TargetPort: 9735, PublishedPort: 9735 }]
            : service === "fnn-hub"
              ? [{ URL: "0.0.0.0", TargetPort: 8228, PublishedPort: 8228 }]
              : [];
      this.containers.set(service, { State: "running", Health: "healthy", Publishers: publishers });
    }
    this.lnd = { "lnd-hub": new FakeLnd("lnd-hub", PUBKEY.LND_HUB), "lnd-demo": new FakeLnd("lnd-demo", PUBKEY.LND_DEMO) };
    this.fnn = {
      "fnn-hub": new FakeFnn("fnn-hub", PUBKEY.FNN_HUB, lockOf(`0x${"11".repeat(20)}`), [
        `/ip4/203.0.113.7/tcp/8228/p2p/${PEER_ID.FNN_HUB}`,
        `/ip4/203.0.113.7/tcp/8228/ws/p2p/${PEER_ID.FNN_HUB}`,
      ]),
      "fnn-demo": new FakeFnn("fnn-demo", PUBKEY.FNN_DEMO, lockOf(`0x${"22".repeat(20)}`)),
    };
    this.runner.on((call) => this.handle(call));
  }

  private handle(call: RecordedCall): CommandResult | undefined {
    if (call.command !== "ssh" || call.script === null) return undefined;
    const script = call.script;
    if (script === "docker compose version --short") {
      return this.composeVersion === null ? fail("ssh: connect to host test-server port 22: Connection refused", 255) : result(`${this.composeVersion}\n`);
    }
    if (script.startsWith("command -v ")) {
      const tool = script.slice("command -v ".length).trim();
      return this.tools.has(tool) ? result(`/usr/bin/${tool}\n`) : fail("", 1);
    }
    const inKit = withoutKitDir(script, this.dir);
    if (inKit === null) return undefined;
    if (inKit.startsWith("test -e ")) return result("", this.files.has(shellWords(inKit)[2] ?? "") ? 0 : 1);
    if (inKit.includes("docker volume inspect")) return result(this.takeoverOutput);
    if (inKit === "ss -ltnH") return result(this.listening);
    if (inKit.startsWith("docker compose ")) return this.compose(shellWords(inKit).slice(2), call.input);
    if (inKit.startsWith("docker image inspect ")) return result("", this.images.has(shellWords(inKit)[3] ?? "") ? 0 : 1);
    if (inKit.startsWith("python3 add_token.py")) {
      const args = shellWords(inKit).slice(2);
      this.addTokenRuns.push(args);
      return this.addToken(args);
    }
    if (inKit.startsWith("curl ")) return this.hub.handle(shellWords(inKit), call.input);
    return undefined;
  }

  private compose(args: string[], input: string): CommandResult {
    const joined = args.join(" ");
    if (joined === "config --services") return result(`${this.active.join("\n")}\n`);
    if (joined === "config --format json") return result(JSON.stringify(this.config));
    if (joined === "ps --all --format json") {
      const lines = [...this.containers].map(([service, state]) => JSON.stringify({ Service: service, Name: `ckbolt-testnet-${service}-1`, ...state }));
      return result(`${lines.join("\n")}\n`);
    }
    if (joined === "port hub 8787") return result(`${this.hubPort}\n`);
    if (args[0] === "exec" && args[1] === "-T") return this.exec(args[2] ?? "", args.slice(3), input);
    this.composeCommands.push(args);
    return result("");
  }

  private exec(service: string, argv: string[], input: string): CommandResult {
    if (!this.containers.has(service) || this.containers.get(service)?.State !== "running") {
      return fail(`service "${service}" is not running`);
    }
    if (argv[0] === "lncli" && (service === "lnd-hub" || service === "lnd-demo")) return this.lnd[service].handle(argv.slice(2));
    if (argv[0] === "sh" && argv[1] === "-c" && (service === "fnn-hub" || service === "fnn-demo")) return this.fnn[service].handle(input);
    if (argv[0] === "bitcoin-cli" && service === "bitcoind") return result(JSON.stringify(this.bitcoind));
    return fail(`fake exec: nothing answers ${service} ${argv.join(" ")}`);
  }
}
