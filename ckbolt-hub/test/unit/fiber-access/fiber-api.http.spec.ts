import type { Response } from "supertest";
import { FIBER_CHANNEL_STATUS } from "../../../src/common/constants/fiber-node.constants";
import { MS_PER_DAY, MS_PER_HOUR } from "../../../src/common/constants/protocol.constants";
import type { FiberNodeDto, InboundChannelDto, InboundChannelOpeningDto } from "../../../src/interfaces/http/contract/responses";
import { expectApiError } from "../../support/hub-http";
import { makeSwap, spyOnLogger } from "../api/api.fixtures";
import {
  BROWSER_NODE,
  FIBER_PATH,
  INBOUND_CKB_AMOUNT,
  INBOUND_RUSD_AMOUNT,
  ONE_CKB,
  P2P_ADDR,
  ROUTING_CHANNELS,
  RUSD_SCRIPT,
  SECOND_NODE,
  THIRD_NODE,
  WS_ADDR,
  WSS_ADDR,
  asTyped,
  channelId,
  channelsTo,
  hubChannel,
  startFiberAccessHub,
  type FiberAccessHub,
  type FiberAccessHubOptions,
} from "./fiber-access.fixtures";

/**
 * The plan's "Contract for the browser Fiber node", over HTTP through the real AppModule (every real module, guard, pipe
 * and filter) on fake nodes:
 *
 * - GET /v1/fiber/node -> 200 { nodeId, network, addresses: { p2p, ws }, assets: [{ id, udtTypeScript }],
 *   inbound: { enabled, amounts: { CKB?, RUSD? } } }
 * - POST /v1/fiber/inbound-channels { nodeId, asset } -> 202 { nodeId, asset, fundingAmount, temporaryChannelId };
 *   404 inbound_disabled, 409 conflict, 422 asset_unavailable, 429 rate_limited
 * - GET /v1/fiber/inbound-channels/:nodeId -> 200 { data: [{ channelId, asset, state, hubBalance, nodeBalance }] }
 */

const SECRET_TOKEN = "EoQKCAoGCAESAhgBEgYIARICGAEaIK-secret-biscuit";

describe("Fiber node API (/v1/fiber/...)", () => {
  let hub: FiberAccessHub | null = null;

  const start = async (options: FiberAccessHubOptions = {}): Promise<FiberAccessHub> => {
    hub = await startFiberAccessHub(options);
    return hub;
  };

  const postInbound = (h: FiberAccessHub, body: unknown, forwardedFor?: string): Promise<Response> => {
    const req = h.http().post(FIBER_PATH.INBOUND).set("content-type", "application/json");
    if (forwardedFor) req.set("x-forwarded-for", forwardedFor);
    return req.send(body as object).then((res) => res);
  };

  beforeEach(() => spyOnLogger());
  afterEach(async () => {
    await hub?.app.close();
    hub = null;
    jest.restoreAllMocks();
  });

  /* ------------------------------------------------------------------------------------------- GET /v1/fiber/node */

  describe("GET /v1/fiber/node", () => {
    it("answers 200 with exactly the contract's fields: id, network, addresses, assets and inbound amounts as strings", async () => {
      const h = await start();
      const res = await h.http().get(FIBER_PATH.NODE).expect(200);
      expect(res.headers["content-type"]).toMatch(/^application\/json/);
      expect(res.body).toEqual<FiberNodeDto>({
        nodeId: h.hubFiber.nodeId,
        network: "devnet",
        addresses: { p2p: [P2P_ADDR], ws: [WS_ADDR, WSS_ADDR] },
        assets: [
          { id: "CKB", udtTypeScript: null, udtWhitelist: null, peerChannels: null },
          {
            id: "RUSD",
            udtTypeScript: RUSD_SCRIPT,
            udtWhitelist: { name: "RUSD", script: RUSD_SCRIPT, cellDeps: [], autoAcceptAmount: INBOUND_RUSD_AMOUNT.toString() },
            peerChannels: null,
          },
        ],
        inbound: {
          enabled: true,
          amounts: { CKB: INBOUND_CKB_AMOUNT.toString(), RUSD: INBOUND_RUSD_AMOUNT.toString() },
          fundable: { CKB: true, RUSD: true },
        },
      });
    });

    it("reports the network the node runs on, not the configured one", async () => {
      const h = await start({ fiberNetwork: "testnet" });
      expect((await h.http().get(FIBER_PATH.NODE).expect(200)).body.network).toBe("testnet");
    });

    it("never shows the node's RPC address or token", async () => {
      const h = await start({ env: { FIBER_RPC_URL: "http://10.0.0.5:8227", FIBER_RPC_TOKEN: SECRET_TOKEN } });
      const text = JSON.stringify((await h.http().get(FIBER_PATH.NODE).expect(200)).body);
      expect(text).not.toContain(SECRET_TOKEN);
      expect(text).not.toContain("10.0.0.5");
      expect(text).not.toContain("8227");
    });

    it("says inbound channels are off with empty amounts, and still gives the addresses, when they are off", async () => {
      const h = await start({ env: { FIBER_INBOUND_ENABLED: "false" } });
      const body = (await h.http().get(FIBER_PATH.NODE).expect(200)).body as FiberNodeDto;
      expect(body.inbound).toEqual({ enabled: false, amounts: {}, fundable: {} });
      expect(body.addresses).toEqual({ p2p: [P2P_ADDR], ws: [WS_ADDR, WSS_ADDR] });
    });

    it("lists only the assets it has an amount for in inbound.amounts", async () => {
      const h = await start({ env: { FIBER_INBOUND_RUSD_AMOUNT: null } });
      expect((await h.http().get(FIBER_PATH.NODE).expect(200)).body.inbound.amounts).toEqual({ CKB: INBOUND_CKB_AMOUNT.toString() });
    });

    it("gives empty address lists when none are configured", async () => {
      const h = await start({ env: { FIBER_INBOUND_ENABLED: "false", FIBER_PUBLIC_P2P_ADDRS: "", FIBER_PUBLIC_WS_ADDRS: "" } });
      expect((await h.http().get(FIBER_PATH.NODE).expect(200)).body.addresses).toEqual({ p2p: [], ws: [] });
    });

    it("answers 503 upstream_unavailable when the hub's fnn does not answer", async () => {
      const h = await start();
      h.hubFiber.failNext = "getInfo";
      const message = expectApiError(await h.http().get(FIBER_PATH.NODE), 503, "upstream_unavailable");
      expect(message).not.toMatch(/simulated/);
    });

    it("falls under the API's per-client rate limit like every other route", async () => {
      const h = await start({ env: { HUB_RATE_LIMIT_PER_MINUTE: "2" } });
      await h.http().get(FIBER_PATH.NODE).expect(200);
      await h.http().get(FIBER_PATH.inboundOf(BROWSER_NODE)).expect(200);
      const refused = await h.http().get(FIBER_PATH.NODE);
      expectApiError(refused, 429, "rate_limited");
      expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    });

    it("is a read: POST is not a route", async () => {
      const h = await start();
      expectApiError(await h.http().post(FIBER_PATH.NODE).send({}), 404, "not_found");
    });
  });

  /* ------------------------------------------------------------------------------- POST /v1/fiber/inbound-channels */

  describe("POST /v1/fiber/inbound-channels", () => {
    it("answers 202 with the opening and a Location to follow, and the hub's fnn opens a private channel with the configured funding", async () => {
      const h = await start();
      h.hubFiber.connectPeer(BROWSER_NODE);
      const res = await postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB" });
      expect(res.status).toBe(202);
      expect(res.headers.location).toBe(FIBER_PATH.inboundOf(BROWSER_NODE));
      expect(res.body).toEqual<InboundChannelOpeningDto>({
        nodeId: BROWSER_NODE,
        asset: "CKB",
        fundingAmount: INBOUND_CKB_AMOUNT.toString(),
        temporaryChannelId: expect.stringMatching(/^0x[0-9a-f]{64}$/) as unknown as string,
      });
      expect(await channelsTo(h.hubFiber, BROWSER_NODE)).toEqual([
        expect.objectContaining({ channelId: res.body.temporaryChannelId, udtTypeScript: null, localBalance: INBOUND_CKB_AMOUNT, public: false, status: "opening" }),
      ]);
    });

    it("opens a RUSD channel with the RUSD amount", async () => {
      const h = await start();
      h.hubFiber.connectPeer(BROWSER_NODE);
      const res = await postInbound(h, { nodeId: BROWSER_NODE, asset: "RUSD" });
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ asset: "RUSD", fundingAmount: INBOUND_RUSD_AMOUNT.toString() });
      expect(await channelsTo(h.hubFiber, BROWSER_NODE)).toMatchObject([{ udtTypeScript: RUSD_SCRIPT, localBalance: INBOUND_RUSD_AMOUNT }]);
    });

    it("takes the node id with 0x and in upper case, and answers with it as fnn writes it", async () => {
      const h = await start();
      h.hubFiber.connectPeer(BROWSER_NODE);
      const res = await postInbound(h, { nodeId: ` ${asTyped(BROWSER_NODE)} `, asset: "CKB" });
      expect(res.status).toBe(202);
      expect(res.body.nodeId).toBe(BROWSER_NODE);
      expect(res.headers.location).toBe(FIBER_PATH.inboundOf(BROWSER_NODE));
    });

    it("lets the client choose neither the amount nor a public channel: extra fields change nothing", async () => {
      const h = await start();
      h.hubFiber.connectPeer(BROWSER_NODE);
      const res = await postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB", fundingAmount: (10n ** 30n).toString(), amount: "1", public: true });
      expect(res.status).toBe(202);
      expect(res.body.fundingAmount).toBe(INBOUND_CKB_AMOUNT.toString());
      expect(await channelsTo(h.hubFiber, BROWSER_NODE)).toMatchObject([{ localBalance: INBOUND_CKB_AMOUNT, public: false }]);
    });

    describe("400 validation_failed", () => {
      it.each([
        ["no body fields", {}],
        ["no node id", { asset: "CKB" }],
        ["no asset", { nodeId: BROWSER_NODE }],
        ["an uncompressed key", { nodeId: `04${"ab".repeat(32)}`, asset: "CKB" }],
        ["a short node id", { nodeId: `02${"ab".repeat(31)}`, asset: "CKB" }],
        ["a libp2p peer id", { nodeId: "QmeBMP2oD7yGmFysdMKAuJRymBDtheZJERdF7xuXH2yuQf", asset: "CKB" }],
        ["a number as node id", { nodeId: 2, asset: "CKB" }],
        ["an asset id that is not one (a digit first)", { nodeId: BROWSER_NODE, asset: "1CKB" }],
        ["an asset id of one letter", { nodeId: BROWSER_NODE, asset: "C" }],
        ["a lower-case asset", { nodeId: BROWSER_NODE, asset: "ckb" }],
      ])("refuses %s without asking the node", async (_what, body) => {
        const h = await start();
        h.hubFiber.connectPeer(BROWSER_NODE);
        expectApiError(await postInbound(h, body), 400, "validation_failed");
        expect(h.hubFiber.calls).not.toContain("openChannel");
        expect(h.hubFiber.calls).not.toContain("isConnected");
      });

      it("refuses a body that is not JSON with 400 bad_request", async () => {
        const h = await start();
        const res = await h.http().post(FIBER_PATH.INBOUND).set("content-type", "application/json").send("{not json");
        expectApiError(res, 400, "bad_request");
      });
    });

    it("answers 404 inbound_disabled when the hub opens no inbound channels, before reading the body", async () => {
      const h = await start({ env: { FIBER_INBOUND_ENABLED: "false" } });
      h.hubFiber.connectPeer(BROWSER_NODE);
      expectApiError(await postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB" }), 404, "inbound_disabled");
      expectApiError(await postInbound(h, { nodeId: "nonsense" }), 404, "inbound_disabled");
      expect(h.hubFiber.calls).not.toContain("openChannel");
    });

    it("answers 422 asset_unavailable for an asset the hub does not serve or has no amount for", async () => {
      const h = await start({ env: { FIBER_INBOUND_RUSD_AMOUNT: null } });
      h.hubFiber.connectPeer(BROWSER_NODE);
      expectApiError(await postInbound(h, { nodeId: BROWSER_NODE, asset: "CWBTC" }), 422, "asset_unavailable");
      expectApiError(await postInbound(h, { nodeId: BROWSER_NODE, asset: "RUSD" }), 422, "asset_unavailable");
      // Well-formed ids (asset ids come from config), but no Fiber asset of the hub: BTC names the Lightning leg.
      expectApiError(await postInbound(h, { nodeId: BROWSER_NODE, asset: "BTC" }), 422, "asset_unavailable");
      expectApiError(await postInbound(h, { nodeId: BROWSER_NODE, asset: "USDI" }), 422, "asset_unavailable");
      expect(h.hubFiber.calls).not.toContain("openChannel");
    });

    it("answers 409 conflict when the node is not connected to the hub's fnn", async () => {
      const h = await start();
      const message = expectApiError(await postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB" }), 409, "conflict");
      expect(message).toMatch(/not connected/);
      expect(h.hubFiber.calls).not.toContain("openChannel");
    });

    it("answers 409 conflict for a second channel in the asset while the first is opening, and once it is ready", async () => {
      const h = await start({ env: { FIBER_INBOUND_MAX_PER_NODE_PER_DAY: "10", FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY: "10" } });
      h.hubFiber.connectPeer(BROWSER_NODE);
      expect((await postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB" })).status).toBe(202);
      expectApiError(await postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB" }), 409, "conflict");
      h.hubFiber.completeChannelOpenings();
      expectApiError(await postInbound(h, { nodeId: asTyped(BROWSER_NODE), asset: "CKB" }), 409, "conflict");
      expect(await channelsTo(h.hubFiber, BROWSER_NODE)).toHaveLength(1);
    });

    it("answers 422 insufficient_liquidity when the funding exceeds the hub's Fiber payout liquidity", async () => {
      const h = await start({ channels: [hubChannel({ channelId: channelId("a1"), localBalance: INBOUND_CKB_AMOUNT })] });
      h.hubFiber.connectPeer(BROWSER_NODE);
      expectApiError(await postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB" }), 422, "insufficient_liquidity");
      expect(h.hubFiber.calls).not.toContain("openChannel");
    });

    it("counts what open swaps reserve, as GET /v1/assets does", async () => {
      const liquidity = 3n * INBOUND_CKB_AMOUNT;
      const h = await start({ channels: [hubChannel({ channelId: channelId("a1"), localBalance: liquidity })] });
      h.hubFiber.connectPeer(BROWSER_NODE);
      h.store.createSwap(makeSwap({ direction: "ln_to_fiber", asset: "CKB", state: "incoming_accepted", fiberAmount: 2n * INBOUND_CKB_AMOUNT + ONE_CKB }));
      const assets = (await h.http().get(FIBER_PATH.ASSETS).expect(200)).body.data as { id: string; liquidity: { fiberAmount: string } }[];
      const advertised = BigInt(assets.find((asset) => asset.id === "CKB")?.liquidity.fiberAmount ?? "0");
      expect(advertised).toBeLessThan(INBOUND_CKB_AMOUNT);
      expectApiError(await postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB" }), 422, "insufficient_liquidity");
    });

    it("answers 503 upstream_unavailable when fnn refuses to open, and that refusal does not count against the caps", async () => {
      const h = await start({ env: { FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY: "1", FIBER_INBOUND_MAX_PER_NODE_PER_DAY: "1" } });
      h.hubFiber.connectPeer(BROWSER_NODE);
      h.hubFiber.failNext = "openChannel";
      const message = expectApiError(await postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB" }), 503, "upstream_unavailable");
      expect(message).not.toMatch(/simulated|openChannel/);
      expect((await postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB" })).status).toBe(202);
    });

    it("answers 503 upstream_unavailable when the hub's fnn does not answer the checks", async () => {
      const h = await start();
      h.hubFiber.connectPeer(BROWSER_NODE);
      h.hubFiber.failNext = "isConnected";
      expectApiError(await postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB" }), 503, "upstream_unavailable");
    });

    describe("429 rate_limited", () => {
      it("caps one client per sliding day, with Retry-After until its oldest channel is a day old", async () => {
        const h = await start({ env: { FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY: "2" } });
        [BROWSER_NODE, SECOND_NODE, THIRD_NODE].forEach((node) => h.hubFiber.connectPeer(node));
        expect((await postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB" })).status).toBe(202);
        h.clock.advance(MS_PER_HOUR);
        expect((await postInbound(h, { nodeId: SECOND_NODE, asset: "CKB" })).status).toBe(202);
        const refused = await postInbound(h, { nodeId: THIRD_NODE, asset: "CKB" });
        expectApiError(refused, 429, "rate_limited");
        expect(refused.headers["retry-after"]).toBe(String((MS_PER_DAY - MS_PER_HOUR) / 1_000));
        expect(await channelsTo(h.hubFiber, THIRD_NODE)).toEqual([]);
        h.clock.advance(MS_PER_DAY - MS_PER_HOUR);
        expect((await postInbound(h, { nodeId: THIRD_NODE, asset: "CKB" })).status).toBe(202);
      });

      it("does not let a client on the internet dodge its cap with X-Forwarded-For (no trusted proxy)", async () => {
        const h = await start({ env: { FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY: "1" } });
        [BROWSER_NODE, SECOND_NODE].forEach((node) => h.hubFiber.connectPeer(node));
        expect((await postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB" }, "198.51.100.1")).status).toBe(202);
        expectApiError(await postInbound(h, { nodeId: SECOND_NODE, asset: "CKB" }, "198.51.100.2"), 429, "rate_limited");
      });

      it("counts clients by the trusted proxy's X-Forwarded-For when HUB_TRUST_PROXY is on (the rate limits' client key)", async () => {
        const h = await start({ env: { HUB_TRUST_PROXY: "true", FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY: "1" } });
        [BROWSER_NODE, SECOND_NODE, THIRD_NODE].forEach((node) => h.hubFiber.connectPeer(node));
        expect((await postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB" }, "198.51.100.1")).status).toBe(202);
        expectApiError(await postInbound(h, { nodeId: SECOND_NODE, asset: "CKB" }, "198.51.100.1"), 429, "rate_limited");
        expect((await postInbound(h, { nodeId: SECOND_NODE, asset: "CKB" }, "198.51.100.2")).status).toBe(202);
      });

      it("caps one node per sliding day whatever the client", async () => {
        const h = await start({ env: { HUB_TRUST_PROXY: "true", FIBER_INBOUND_MAX_PER_NODE_PER_DAY: "1" } });
        h.hubFiber.connectPeer(BROWSER_NODE);
        expect((await postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB" }, "198.51.100.1")).status).toBe(202);
        const refused = await postInbound(h, { nodeId: asTyped(BROWSER_NODE), asset: "RUSD" }, "198.51.100.2");
        expect(expectApiError(refused, 429, "rate_limited")).toMatch(/this Fiber node/);
        expect(Number(refused.headers["retry-after"])).toBe(MS_PER_DAY / 1_000);
      });

      it("refuses past FIBER_INBOUND_MAX_OPEN inbound channels with Retry-After of an hour", async () => {
        const h = await start({ env: { HUB_TRUST_PROXY: "true", FIBER_INBOUND_MAX_OPEN: "2" } });
        [BROWSER_NODE, SECOND_NODE, THIRD_NODE].forEach((node) => h.hubFiber.connectPeer(node));
        expect((await postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB" }, "198.51.100.1")).status).toBe(202);
        expect((await postInbound(h, { nodeId: SECOND_NODE, asset: "RUSD" }, "198.51.100.2")).status).toBe(202);
        const refused = await postInbound(h, { nodeId: THIRD_NODE, asset: "CKB" }, "198.51.100.3");
        expectApiError(refused, 429, "rate_limited");
        expect(refused.headers["retry-after"]).toBe(String(MS_PER_HOUR / 1_000));
      });

      it("counts the open inbound channels from the node, so they survive a restart of the hub", async () => {
        const opened = hubChannel({ channelId: channelId("f1"), peer: SECOND_NODE, public: false, localBalance: INBOUND_CKB_AMOUNT });
        const h = await start({ env: { FIBER_INBOUND_MAX_OPEN: "1" }, channels: [...ROUTING_CHANNELS, opened] });
        h.hubFiber.connectPeer(BROWSER_NODE);
        expectApiError(await postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB" }), 429, "rate_limited");
      });
    });

    it("opens one channel when the same request arrives twice at once", async () => {
      const h = await start({ env: { HUB_TRUST_PROXY: "true" } });
      h.hubFiber.connectPeer(BROWSER_NODE);
      const [a, b] = await Promise.all([
        postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB" }, "198.51.100.1"),
        postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB" }, "198.51.100.2"),
      ]);
      expect([a.status, b.status].sort()).toEqual([202, 409]);
      expect(await channelsTo(h.hubFiber, BROWSER_NODE)).toHaveLength(1);
    });
  });

  /* ---------------------------------------------------------------------- GET /v1/fiber/inbound-channels/:nodeId */

  describe("GET /v1/fiber/inbound-channels/:nodeId", () => {
    it("answers 200 { data: [] } for a node without channels", async () => {
      const h = await start();
      const res = await h.http().get(FIBER_PATH.inboundOf(SECOND_NODE)).expect(200);
      expect(res.body).toEqual({ data: [] });
    });

    it("follows the channel from opening to ready, with balances as decimal strings of base units", async () => {
      const h = await start();
      h.hubFiber.connectPeer(BROWSER_NODE);
      const opened = await postInbound(h, { nodeId: BROWSER_NODE, asset: "CKB" });
      const location = opened.headers.location as string;
      expect((await h.http().get(location).expect(200)).body).toEqual({
        data: [{ channelId: opened.body.temporaryChannelId, asset: "CKB", state: "opening", hubBalance: INBOUND_CKB_AMOUNT.toString(), nodeBalance: "0" }],
      });
      h.hubFiber.completeChannelOpenings();
      expect((await h.http().get(location).expect(200)).body.data).toMatchObject([{ state: "ready", hubBalance: INBOUND_CKB_AMOUNT.toString() }]);
    });

    it("lists only live channels the hub opened to that node in assets it serves, with exact large balances", async () => {
      const huge = 2n ** 100n + 3n;
      const h = await start({
        channels: [
          ...ROUTING_CHANNELS,
          hubChannel({ channelId: channelId("d1"), peer: BROWSER_NODE, public: false, localBalance: huge, remoteBalance: 7n }),
          hubChannel({ channelId: channelId("d2"), peer: BROWSER_NODE, public: false, status: FIBER_CHANNEL_STATUS.CLOSING, udtTypeScript: RUSD_SCRIPT, localBalance: 1n }),
          hubChannel({ channelId: channelId("d3"), peer: BROWSER_NODE, public: false, status: FIBER_CHANNEL_STATUS.CLOSED }),
          hubChannel({ channelId: channelId("d4"), peer: BROWSER_NODE, public: false, openedByPeer: true }),
          hubChannel({ channelId: channelId("d5"), peer: SECOND_NODE, public: false }),
        ],
      });
      const res = await h.http().get(FIBER_PATH.inboundOf(asTyped(BROWSER_NODE))).expect(200);
      expect(res.body).toEqual({
        data: [
          { channelId: channelId("d1"), asset: "CKB", state: "ready", hubBalance: huge.toString(), nodeBalance: "7" },
          { channelId: channelId("d2"), asset: "RUSD", state: "closing", hubBalance: "1", nodeBalance: "0" },
        ] satisfies InboundChannelDto[],
      });
    });

    it("answers 400 validation_failed for a malformed node id", async () => {
      const h = await start();
      expectApiError(await h.http().get(FIBER_PATH.inboundOf("not-a-node")), 400, "validation_failed");
      expectApiError(await h.http().get(FIBER_PATH.inboundOf(`04${"ab".repeat(32)}`)), 400, "validation_failed");
    });

    it("answers 404 inbound_disabled when the hub opens no inbound channels", async () => {
      const h = await start({ env: { FIBER_INBOUND_ENABLED: "false" } });
      expectApiError(await h.http().get(FIBER_PATH.inboundOf(BROWSER_NODE)), 404, "inbound_disabled");
    });

    it("answers 503 upstream_unavailable when the hub's fnn does not answer", async () => {
      const h = await start();
      h.hubFiber.failNext = "listChannelDetails";
      expectApiError(await h.http().get(FIBER_PATH.inboundOf(BROWSER_NODE)), 503, "upstream_unavailable");
    });

    it("has no collection route without a node id", async () => {
      const h = await start();
      expectApiError(await h.http().get(FIBER_PATH.INBOUND), 404, "not_found");
    });
  });
});
