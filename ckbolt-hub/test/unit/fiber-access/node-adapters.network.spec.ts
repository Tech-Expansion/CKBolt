import { HttpStatus } from "@nestjs/common";
import { systemClock } from "../../../src/application/ports/clock.port";
import type { FiberChannel } from "../../../src/application/ports/fiber.port";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { HubError } from "../../../src/common/errors/hub.error";
import { FiberRpcAdapter } from "../../../src/infrastructure/fiber/fiber-rpc.adapter";
import { FiberRpcClient, type HttpPost } from "../../../src/infrastructure/fiber/fiber-rpc.client";
import { FiberRpcError, FiberRpcTransportError } from "../../../src/infrastructure/fiber/fiber-rpc.errors";
import { LndLightningAdapter } from "../../../src/infrastructure/lightning/lnd-lightning.adapter";
import type { BtcNetwork, CkbNetwork } from "../../../src/domain/types";
import { NODE_PUBKEY, PEER_PUBKEY, RUSD_SCRIPT, ScriptedFiberRpc, failWith, hex, wireChannel, wireNodeInfo, wireRusdScript } from "../fiber/fiber.fixtures";
import { REGTEST_SETTINGS, START_HEIGHT } from "../lightning/lightning.fixtures";
import { answer, createGrpcStub, rawGetInfo, type LndGrpcStub } from "../lightning/lnd-grpc.stub";

/**
 * The node adapters' side of phase 3b: each node's own network (fnn node_info chain_hash, LND getinfo chains through the
 * real `lightning` package), and the fnn calls inbound channels need (list_peers, list_channels with a pubkey filter,
 * open_channel with funding_udt_type_script and public: false), checked on the wire format of fnn v0.9.1
 * (docs/research/fiber-node.md 2.3 and 2.4, and the devnet's fnn answers).
 */

const TESTNET_CHAIN_HASH = "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606";
const MAINNET_CHAIN_HASH = "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5";
const DEVNET_CHAIN_HASH = "0xeac93bcfaad487169f94615169b26f8363de2a70ade4dbb6c602859b43109f32";

const transportError = (method: string) => () => {
  throw new FiberRpcTransportError(method, "timeout", "no answer");
};

describe("FiberRpcAdapter: the node's own network", () => {
  it.each<[string, string, CkbNetwork]>([
    ["the testnet genesis", TESTNET_CHAIN_HASH, "testnet"],
    ["the mainnet genesis", MAINNET_CHAIN_HASH, "mainnet"],
    ["a devnet's own genesis", DEVNET_CHAIN_HASH, "devnet"],
  ])("reads %s as %s, whatever network the hub is configured for", async (_what, chainHash, network) => {
    for (const configured of ["devnet", "testnet", "mainnet"] as const) {
      const rpc = new ScriptedFiberRpc().on("node_info", () => ({ ...wireNodeInfo(), chain_hash: chainHash }));
      await expect(new FiberRpcAdapter(rpc, configured).getInfo()).resolves.toEqual({ nodeId: NODE_PUBKEY, network, version: "0.9.1" });
    }
  });

  it("refuses an answer without a chain_hash as unreadable instead of guessing a network", async () => {
    const { chain_hash: _left, ...withoutChain } = wireNodeInfo();
    const rpc = new ScriptedFiberRpc().on("node_info", () => withoutChain);
    await expect(new FiberRpcAdapter(rpc, "testnet").getInfo()).rejects.toThrow();
  });
});

describe("FiberRpcAdapter: peers and channels for inbound channels", () => {
  let rpc: ScriptedFiberRpc;
  let adapter: FiberRpcAdapter;

  beforeEach(() => {
    rpc = new ScriptedFiberRpc();
    adapter = new FiberRpcAdapter(rpc, "testnet");
  });

  describe("isConnected (list_peers)", () => {
    const peers = { peers: [{ pubkey: PEER_PUBKEY, address: "/ip4/172.27.0.4/tcp/48170/p2p/QmRTgGQkKivdiiG4wiNGvsupDU1fRKeRawy8E3qvYgjTtk" }] };

    it("calls list_peers without params and finds the node whatever its spelling", async () => {
      rpc.on("list_peers", () => peers);
      await expect(adapter.isConnected(PEER_PUBKEY)).resolves.toBe(true);
      await expect(adapter.isConnected(`0x${PEER_PUBKEY.toUpperCase()}`)).resolves.toBe(true);
      expect(rpc.calls[0]).toEqual({ method: "list_peers", params: [] });
    });

    it("is false for a node that is not among the peers, or when there is none", async () => {
      rpc.once("list_peers", () => peers).once("list_peers", () => ({ peers: [] }));
      await expect(adapter.isConnected(NODE_PUBKEY)).resolves.toBe(false);
      await expect(adapter.isConnected(PEER_PUBKEY)).resolves.toBe(false);
    });

    it("matches whole ids only, not a prefix", async () => {
      rpc.on("list_peers", () => peers);
      await expect(adapter.isConnected(PEER_PUBKEY.slice(0, 64))).resolves.toBe(false);
    });

    it("lets an fnn error through as a plain Error, and a transport failure as a 503", async () => {
      rpc.once("list_peers", failWith("list_peers", "internal error")).once("list_peers", transportError("list_peers"));
      const refused = await adapter.isConnected(PEER_PUBKEY).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(FiberRpcError);
      expect(refused).not.toBeInstanceOf(HubError);
      await expect(adapter.isConnected(PEER_PUBKEY)).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE, code: API_ERROR_CODE.UPSTREAM_UNAVAILABLE });
    });
  });

  describe("listChannelDetails (list_channels)", () => {
    it("asks for every channel without a filter, and for one peer's with its pubkey written as fnn writes it", async () => {
      rpc.on("list_channels", () => ({ channels: [] }));
      await adapter.listChannelDetails();
      const unfiltered = rpc.calls.length;
      await adapter.listChannelDetails(`0x${PEER_PUBKEY.toUpperCase()}`);
      const params = rpc.calls.map((call) => call.params[0] as Record<string, unknown>);
      expect(params.length).toBeGreaterThan(unfiltered);
      for (const call of params.slice(0, unfiltered)) expect(call).not.toHaveProperty("pubkey");
      for (const call of params.slice(unfiltered)) expect(call).toMatchObject({ pubkey: PEER_PUBKEY });
      for (const call of params) expect(call).not.toHaveProperty("include_closed", true);
    });

    it.each<[string, FiberChannel["status"]]>([
      ["NegotiatingFunding", "opening"],
      ["CollaboratingFundingTx", "opening"],
      ["SigningCommitment", "opening"],
      ["AwaitingTxSignatures", "opening"],
      ["AwaitingChannelReady", "opening"],
      ["ChannelReady", "ready"],
      ["CHANNEL_READY", "ready"],
      ["ShuttingDown", "closing"],
      ["Closed", "closed"],
    ])("reads the state %s as %s", async (stateName, status) => {
      rpc.on("list_channels", () => ({ channels: [wireChannel({ stateName })] }));
      const [channel] = await adapter.listChannelDetails();
      expect(channel?.status).toBe(status);
      expect(channel?.ready).toBe(status === "ready");
    });

    it("maps who opened the channel, whether it is public, its asset and both balances", async () => {
      const mine = { ...wireChannel({ isAcceptor: false, udtScript: wireRusdScript(), localBalance: 20n, remoteBalance: 3n }), is_public: false };
      const theirs = wireChannel({ channelId: `0x${"c3".repeat(32)}`, isAcceptor: true });
      rpc.on("list_channels", () => ({ channels: [mine, theirs] }));
      const [hubOpened, peerOpened] = await adapter.listChannelDetails(PEER_PUBKEY);
      expect(hubOpened).toEqual<FiberChannel>({
        channelId: `0x${"c1".repeat(32)}`,
        peer: PEER_PUBKEY,
        udtTypeScript: RUSD_SCRIPT,
        ready: true,
        localBalance: 20n,
        remoteBalance: 3n,
        status: "ready",
        public: false,
        openedByPeer: false,
      });
      expect(peerOpened).toMatchObject({ public: true, openedByPeer: true, udtTypeScript: null });
    });

    /**
     * fnn v0.9.1 rpc/channel.rs list_channels: without `only_pending` it reads only the stored channel actor states; the
     * "channel-opening records (outbound) whose ChannelActorState is not yet" stored (open_channel sent, the peer has not
     * accepted yet) are listed only with `only_pending: true`, as NegotiatingFunding. The port promises every channel that
     * is not closed, "ready or still opening", and the inbound rules (one channel per node and asset, open or opening; the
     * cap on open inbound channels; GET /v1/fiber/inbound-channels/:nodeId right after the 202) rely on it.
     */
    it("lists a channel the hub has just asked to open, which fnn shows only with only_pending, as opening", async () => {
      const ready = wireChannel({ channelId: `0x${"a1".repeat(32)}` });
      const accepted = { ...wireChannel({ channelId: `0x${"a2".repeat(32)}`, stateName: "AwaitingChannelReady" }), is_public: false };
      const waitingForPeer = { ...wireChannel({ channelId: `0x${"a3".repeat(32)}`, stateName: "NegotiatingFunding", localBalance: 500n, remoteBalance: 0n }), is_public: false };
      rpc.on("list_channels", (params) => ({ channels: params?.only_pending === true ? [accepted, waitingForPeer] : [ready, accepted] }));
      const channels = await adapter.listChannelDetails(PEER_PUBKEY);
      expect(channels.map((channel) => [channel.channelId, channel.status]).sort()).toEqual([
        [`0x${"a1".repeat(32)}`, "ready"],
        [`0x${"a2".repeat(32)}`, "opening"],
        [`0x${"a3".repeat(32)}`, "opening"],
      ]);
    });

    it("counts a channel whose opener or visibility fnn does not say as opened by the peer and private", async () => {
      const { is_public: _p, ...noVisibility } = wireChannel({ isAcceptor: null });
      rpc.on("list_channels", () => ({ channels: [noVisibility] }));
      const [channel] = await adapter.listChannelDetails();
      expect(channel).toMatchObject({ openedByPeer: true, public: false });
    });
  });

  describe("openChannel (open_channel)", () => {
    it("opens a private CKB channel with the exact funding in hex and no UDT field", async () => {
      rpc.on("open_channel", () => ({ temporary_channel_id: `0x${"7e".repeat(32)}` }));
      const funding = 2n ** 70n + 1n;
      await expect(adapter.openChannel({ peer: `0x${PEER_PUBKEY.toUpperCase()}`, fundingAmount: funding, udtTypeScript: null, public: false })).resolves.toEqual({
        temporaryChannelId: `0x${"7e".repeat(32)}`,
      });
      expect(rpc.calls).toEqual([{ method: "open_channel", params: [{ pubkey: PEER_PUBKEY, funding_amount: hex(funding), public: false }] }]);
    });

    it("opens a UDT channel with funding_udt_type_script in fnn's snake_case script", async () => {
      rpc.on("open_channel", () => ({ temporary_channel_id: `0x${"7e".repeat(32)}` }));
      await adapter.openChannel({ peer: PEER_PUBKEY, fundingAmount: 2_000_000_000n, udtTypeScript: RUSD_SCRIPT, public: false });
      expect(rpc.paramsOf("open_channel")).toEqual({
        pubkey: PEER_PUBKEY,
        funding_amount: "0x77359400",
        public: false,
        funding_udt_type_script: wireRusdScript(),
      });
    });

    it("never sets the commitment delay: fnn's default, which the hub's timing assumes for channels it opened", async () => {
      rpc.on("open_channel", () => ({ temporary_channel_id: `0x${"7e".repeat(32)}` }));
      await adapter.openChannel({ peer: PEER_PUBKEY, fundingAmount: 1n, udtTypeScript: null, public: true });
      expect(Object.keys(rpc.paramsOf("open_channel") ?? {})).toEqual(["pubkey", "funding_amount", "public"]);
    });

    it("throws fnn's refusal as a plain Error (nothing opened), and a lost answer as a 503 HubError (maybe opening)", async () => {
      rpc.once("open_channel", failWith("open_channel", "Peer not found")).once("open_channel", transportError("open_channel"));
      const args = { peer: PEER_PUBKEY, fundingAmount: 1n, udtTypeScript: null, public: false };
      const refused = await adapter.openChannel(args).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(FiberRpcError);
      expect(refused).not.toBeInstanceOf(HubError);
      await expect(adapter.openChannel(args)).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE, code: API_ERROR_CODE.UPSTREAM_UNAVAILABLE });
    });
  });
});

describe("FiberRpcClient: the new calls on the wire", () => {
  function recordingClient(result: unknown) {
    const bodies: Record<string, unknown>[] = [];
    const post: HttpPost = async (_url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) };
    };
    return { bodies, adapter: new FiberRpcAdapter(new FiberRpcClient({ url: "http://127.0.0.1:8227", timeoutMs: 1_000, httpPost: post }), "testnet") };
  }

  it("sends list_peers with an empty params array, as fnn takes it", async () => {
    const { bodies, adapter } = recordingClient({ peers: [] });
    await adapter.isConnected(PEER_PUBKEY);
    expect(bodies[0]).toMatchObject({ jsonrpc: "2.0", method: "list_peers", params: [] });
  });

  it("sends open_channel with one params object", async () => {
    const { bodies, adapter } = recordingClient({ temporary_channel_id: `0x${"7e".repeat(32)}` });
    await adapter.openChannel({ peer: PEER_PUBKEY, fundingAmount: 50_000_000_000n, udtTypeScript: null, public: false });
    expect(bodies[0]).toMatchObject({ method: "open_channel", params: [{ pubkey: PEER_PUBKEY, funding_amount: "0xba43b7400", public: false }] });
  });

  it("reads an answer without a temporary channel id as unreadable (503: the channel may be opening), not as a refusal", async () => {
    const { adapter } = recordingClient({ channel_id: `0x${"7e".repeat(32)}` });
    const error = await adapter.openChannel({ peer: PEER_PUBKEY, fundingAmount: 1n, udtTypeScript: null, public: false }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HubError);
    expect(error).toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
  });
});

describe("LndLightningAdapter over the real `lightning` package: the node's own network", () => {
  let stub: LndGrpcStub;
  let adapter: LndLightningAdapter;

  /** The hub configured for `configured`, talking to an LND whose getinfo names `chains`. */
  function adapterOn(configured: BtcNetwork, chains: { chain: string; network: string }[]): LndLightningAdapter {
    stub = createGrpcStub();
    answer(stub.default.getInfo, () => ({ ...rawGetInfo(START_HEIGHT), chains }));
    adapter = new LndLightningAdapter(stub.lnd, { ...REGTEST_SETTINGS, network: configured }, systemClock);
    return adapter;
  }

  afterEach(() => adapter.close());

  it.each<[string, BtcNetwork]>([
    ["regtest", "regtest"],
    ["signet", "signet"],
    ["testnet", "testnet"],
    ["testnet4", "testnet4"],
    ["mainnet", "mainnet"],
  ])("reports an LND on bitcoin %s as %s, not the network the hub is configured for", async (lndNetwork, expected) => {
    await expect(adapterOn("regtest", [{ chain: "bitcoin", network: lndNetwork }]).getInfo()).resolves.toMatchObject({ network: expected });
  });

  it("reports null for a chain the hub does not know", async () => {
    await expect(adapterOn("regtest", [{ chain: "litecoin", network: "mainnet" }]).getInfo()).resolves.toMatchObject({ network: null });
    adapter.close();
    await expect(adapterOn("regtest", []).getInfo()).resolves.toMatchObject({ network: null });
  });

  it("keeps the rest of getinfo as before", async () => {
    await expect(adapterOn("signet", [{ chain: "bitcoin", network: "signet" }]).getInfo()).resolves.toMatchObject({ blockHeight: START_HEIGHT, synced: true });
  });
});
