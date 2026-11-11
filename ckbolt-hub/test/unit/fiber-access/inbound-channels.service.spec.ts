import { HttpStatus } from "@nestjs/common";
import { InboundChannelsService } from "../../../src/application/fiber-node/inbound-channels.service";
import type { InboundChannelOpening, OpenInboundChannelInput } from "../../../src/application/fiber-node/inbound-channels.contract";
import type { OpenChannelArgs } from "../../../src/application/ports/fiber.port";
import { API_ERROR_CODE, type ApiErrorCode } from "../../../src/common/constants/api.constants";
import { FIBER_CHANNEL_STATUS, INBOUND_CHANNELS_FULL_RETRY_AFTER_SECONDS } from "../../../src/common/constants/fiber-node.constants";
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_SECOND } from "../../../src/common/constants/protocol.constants";
import { HubError, RateLimitedError } from "../../../src/common/errors/hub.error";
import type { HubConfig } from "../../../src/config/hub.config";
import type { FiberAssetId } from "../../../src/domain/types";
import {
  FakeChannelOpenLog,
  FakeClock,
  FakeFiberNetwork,
  FakeInboundOpenStore,
  FakeSwapStore,
  type FakeChannel,
  type FakeFiberNode,
} from "../../fakes";
import { makeSwap, spyOnLogger } from "../api/api.fixtures";
import {
  BROWSER_NODE,
  INBOUND_CKB_AMOUNT,
  INBOUND_RUSD_AMOUNT,
  ONE_CKB,
  RELAY_NODE,
  ROUTING_CHANNELS,
  RUSD_SCRIPT,
  SECOND_NODE,
  THIRD_NODE,
  UNSERVED_UDT_SCRIPT,
  asTyped,
  assetsOf,
  channelId,
  channelsTo,
  hubChannel,
  inboundConfig,
  type EnvPatch,
} from "./fiber-access.fixtures";

/**
 * InboundChannelsService: the hub's fnn opens a private channel, funded with the configured amount, to a node connected
 * to it. Checked against the plan's contract and docs/architecture.md "Inbound channels": inbound on and asset offered,
 * daily caps per client and per node, connected, one channel per node and asset (open or opening), the cap on open
 * inbound channels, and the hub's Fiber payout liquidity; opens one at a time.
 */

const CLIENT = "203.0.113.50";
const OTHER_CLIENT = "198.51.100.9";

interface Harness {
  service: InboundChannelsService;
  node: FakeFiberNode;
  clock: FakeClock;
  store: FakeSwapStore;
  config: HubConfig;
  openLog: FakeChannelOpenLog;
}

function harness(options: { env?: EnvPatch; channels?: FakeChannel[] } = {}): Harness {
  const config = inboundConfig(options.env);
  const clock = new FakeClock();
  const node = new FakeFiberNetwork(config.ckb.network, clock).node("hub");
  node.setChannels(options.channels ?? ROUTING_CHANNELS);
  const store = new FakeSwapStore(clock);
  const openLog = new FakeChannelOpenLog();
  const service = new InboundChannelsService(node, store, assetsOf(config), openLog, new FakeInboundOpenStore(), clock, config);
  return { service, node, clock, store, config, openLog };
}

const input = (nodeId: string, asset: FiberAssetId = "CKB", clientKey = CLIENT): OpenInboundChannelInput => ({ nodeId, asset, clientKey });

/**
 * The HubError `promise` rejects with, checked for its status and code and, unless `ownMessage` is false (an error the
 * node itself raised, passed on unchanged), for a plain sentence written by the hub.
 */
async function hubErrorOf(promise: Promise<unknown>, status: number, code: ApiErrorCode, ownMessage = true): Promise<HubError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected ${status} ${code}`);
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(HubError);
  expect(error).toMatchObject({ status, code });
  if (ownMessage) expect((error as HubError).message).toMatch(/^[A-Z].*\.$/);
  return error as HubError;
}

describe("InboundChannelsService", () => {
  beforeEach(() => spyOnLogger());
  afterEach(() => jest.restoreAllMocks());

  describe("open: the channel it starts", () => {
    it("opens a private CKB channel funded with exactly the configured amount, from the hub's own wallet", async () => {
      const h = harness();
      h.node.connectPeer(BROWSER_NODE);
      const openChannel = jest.spyOn(h.node, "openChannel");
      const opening = await h.service.open(input(BROWSER_NODE));
      expect(openChannel).toHaveBeenCalledTimes(1);
      expect(openChannel.mock.calls[0]?.[0]).toEqual<OpenChannelArgs>({ peer: BROWSER_NODE, fundingAmount: INBOUND_CKB_AMOUNT, udtTypeScript: null, public: false });
      expect(opening).toEqual<InboundChannelOpening>({
        nodeId: BROWSER_NODE,
        asset: "CKB",
        fundingAmount: INBOUND_CKB_AMOUNT,
        temporaryChannelId: expect.stringMatching(/^0x[0-9a-f]{64}$/) as unknown as string,
      });
      const [channel] = await channelsTo(h.node, BROWSER_NODE);
      expect(channel).toMatchObject({ channelId: opening.temporaryChannelId, status: "opening", public: false, openedByPeer: false, localBalance: INBOUND_CKB_AMOUNT });
    });

    it("opens a RUSD channel in the RUSD type script, funded with the RUSD amount", async () => {
      const h = harness();
      h.node.connectPeer(BROWSER_NODE);
      const openChannel = jest.spyOn(h.node, "openChannel");
      const opening = await h.service.open(input(BROWSER_NODE, "RUSD"));
      expect(openChannel.mock.calls[0]?.[0]).toEqual<OpenChannelArgs>({ peer: BROWSER_NODE, fundingAmount: INBOUND_RUSD_AMOUNT, udtTypeScript: RUSD_SCRIPT, public: false });
      expect(opening).toMatchObject({ nodeId: BROWSER_NODE, asset: "RUSD", fundingAmount: INBOUND_RUSD_AMOUNT });
    });

    it("writes the node id the way fnn does (lower-case hex without 0x), whatever the caller typed", async () => {
      const h = harness();
      h.node.connectPeer(BROWSER_NODE);
      const openChannel = jest.spyOn(h.node, "openChannel");
      const opening = await h.service.open(input(asTyped(BROWSER_NODE)));
      expect(opening.nodeId).toBe(BROWSER_NODE);
      expect(openChannel.mock.calls[0]?.[0].peer).toBe(BROWSER_NODE);
    });

    it("asks the node in order: connected?, its channels, then open", async () => {
      const h = harness();
      h.node.connectPeer(BROWSER_NODE);
      await h.service.open(input(BROWSER_NODE));
      expect(h.node.calls).toEqual(["isConnected", "listChannelDetails", "openChannel"]);
    });
  });

  describe("open: refusals (each opens nothing)", () => {
    it("answers 404 inbound_disabled when inbound channels are off, without asking the node", async () => {
      const h = harness({ env: { FIBER_INBOUND_ENABLED: "false" } });
      h.node.connectPeer(BROWSER_NODE);
      expect(h.service.enabled).toBe(false);
      await hubErrorOf(h.service.open(input(BROWSER_NODE)), HttpStatus.NOT_FOUND, API_ERROR_CODE.INBOUND_DISABLED);
      expect(h.node.calls).toEqual([]);
    });

    it("answers 422 asset_unavailable for an asset the hub does not serve", async () => {
      const h = harness();
      h.node.connectPeer(BROWSER_NODE);
      await hubErrorOf(h.service.open(input(BROWSER_NODE, "CWBTC")), HttpStatus.UNPROCESSABLE_ENTITY, API_ERROR_CODE.ASSET_UNAVAILABLE);
      expect(h.node.calls).toEqual([]);
    });

    it("answers 422 asset_unavailable for a served asset without an inbound amount", async () => {
      const h = harness({ env: { FIBER_INBOUND_RUSD_AMOUNT: null } });
      h.node.connectPeer(BROWSER_NODE);
      await hubErrorOf(h.service.open(input(BROWSER_NODE, "RUSD")), HttpStatus.UNPROCESSABLE_ENTITY, API_ERROR_CODE.ASSET_UNAVAILABLE);
      expect(h.node.calls).toEqual([]);
    });

    it("answers 409 conflict when the node is not connected to the hub's node", async () => {
      const h = harness();
      const error = await hubErrorOf(h.service.open(input(BROWSER_NODE)), HttpStatus.CONFLICT, API_ERROR_CODE.CONFLICT);
      expect(error.message).toMatch(/not connected/);
      expect(h.node.calls).not.toContain("openChannel");
    });

    it("answers 409 conflict while the hub has a channel to the node in the asset that is opening, ready or closing", async () => {
      for (const status of [FIBER_CHANNEL_STATUS.OPENING, FIBER_CHANNEL_STATUS.READY, FIBER_CHANNEL_STATUS.CLOSING]) {
        const existing = hubChannel({ channelId: channelId("b0"), peer: BROWSER_NODE, status, public: false, localBalance: INBOUND_CKB_AMOUNT });
        const h = harness({ channels: [...ROUTING_CHANNELS, existing] });
        h.node.connectPeer(BROWSER_NODE);
        const error = await hubErrorOf(h.service.open(input(BROWSER_NODE)), HttpStatus.CONFLICT, API_ERROR_CODE.CONFLICT);
        expect(error.message).toMatch(/already has a CKB channel/);
        expect(h.node.calls).not.toContain("openChannel");
      }
    });

    it("counts any live channel the hub opened to the node in the asset, its public routing channels included", async () => {
      const h = harness();
      h.node.connectPeer(RELAY_NODE);
      await hubErrorOf(h.service.open(input(RELAY_NODE)), HttpStatus.CONFLICT, API_ERROR_CODE.CONFLICT);
    });

    it("lets one channel per node and asset: a CKB channel does not stop a RUSD one", async () => {
      const h = harness({ env: { FIBER_INBOUND_MAX_PER_NODE_PER_DAY: "5" } });
      h.node.connectPeer(BROWSER_NODE);
      await h.service.open(input(BROWSER_NODE, "CKB"));
      await expect(h.service.open(input(BROWSER_NODE, "RUSD", OTHER_CLIENT))).resolves.toMatchObject({ asset: "RUSD" });
      await hubErrorOf(h.service.open(input(BROWSER_NODE, "CKB", OTHER_CLIENT)), HttpStatus.CONFLICT, API_ERROR_CODE.CONFLICT);
    });

    it("does not count a closed channel, or one the node opened to the hub", async () => {
      const closed = hubChannel({ channelId: channelId("b1"), peer: BROWSER_NODE, status: FIBER_CHANNEL_STATUS.CLOSED, public: false });
      const theirs = hubChannel({ channelId: channelId("b2"), peer: BROWSER_NODE, public: false, openedByPeer: true, remoteBalance: 100n * ONE_CKB });
      const h = harness({ channels: [...ROUTING_CHANNELS, closed, theirs] });
      h.node.connectPeer(BROWSER_NODE);
      await expect(h.service.open(input(BROWSER_NODE))).resolves.toMatchObject({ asset: "CKB" });
    });

    it("answers 429 rate_limited with an hour's Retry-After once FIBER_INBOUND_MAX_OPEN inbound channels exist", async () => {
      const h = harness({ env: { FIBER_INBOUND_MAX_OPEN: "1" } });
      h.node.connectPeer(BROWSER_NODE);
      h.node.connectPeer(SECOND_NODE);
      await h.service.open(input(BROWSER_NODE));
      const error = await hubErrorOf(h.service.open(input(SECOND_NODE, "CKB", OTHER_CLIENT)), HttpStatus.TOO_MANY_REQUESTS, API_ERROR_CODE.RATE_LIMITED);
      expect(error).toBeInstanceOf(RateLimitedError);
      expect((error as RateLimitedError).retryAfterSeconds).toBe(INBOUND_CHANNELS_FULL_RETRY_AFTER_SECONDS);
      expect(INBOUND_CHANNELS_FULL_RETRY_AFTER_SECONDS).toBe(MS_PER_HOUR / MS_PER_SECOND);
    });

    it("counts toward FIBER_INBOUND_MAX_OPEN only live private channels the hub opened, ready or not", async () => {
      const others: FakeChannel[] = [
        hubChannel({ channelId: channelId("c1"), peer: THIRD_NODE, public: true }),
        hubChannel({ channelId: channelId("c2"), peer: THIRD_NODE, public: false, openedByPeer: true }),
        hubChannel({ channelId: channelId("c3"), peer: THIRD_NODE, public: false, status: FIBER_CHANNEL_STATUS.CLOSED }),
      ];
      const h = harness({ env: { FIBER_INBOUND_MAX_OPEN: "1" }, channels: [...ROUTING_CHANNELS, ...others] });
      h.node.connectPeer(BROWSER_NODE);
      await expect(h.service.open(input(BROWSER_NODE))).resolves.toMatchObject({ nodeId: BROWSER_NODE });

      const full = harness({ env: { FIBER_INBOUND_MAX_OPEN: "1" }, channels: [...ROUTING_CHANNELS, hubChannel({ channelId: channelId("c4"), peer: THIRD_NODE, public: false })] });
      full.node.connectPeer(BROWSER_NODE);
      await hubErrorOf(full.service.open(input(BROWSER_NODE)), HttpStatus.TOO_MANY_REQUESTS, API_ERROR_CODE.RATE_LIMITED);
    });

    it("answers 422 insufficient_liquidity when the funding exceeds the hub's Fiber payout liquidity in the asset", async () => {
      const thin = hubChannel({ channelId: channelId("a1"), localBalance: INBOUND_CKB_AMOUNT });
      const h = harness({ channels: [thin] });
      h.node.connectPeer(BROWSER_NODE);
      const error = await hubErrorOf(h.service.open(input(BROWSER_NODE)), HttpStatus.UNPROCESSABLE_ENTITY, API_ERROR_CODE.INSUFFICIENT_LIQUIDITY);
      expect(error.message).toMatch(/500 CKB/);
      expect(h.node.calls).not.toContain("openChannel");
    });

    it("opens when the payout liquidity, routing fee budget left aside, covers the funding exactly", async () => {
      const feeBps = BigInt(inboundConfig().swaps.fiberMaxFeeBps);
      const exact = INBOUND_CKB_AMOUNT + (INBOUND_CKB_AMOUNT * feeBps + 9_999n) / 10_000n;
      const h = harness({ channels: [hubChannel({ channelId: channelId("a1"), localBalance: exact })] });
      h.node.connectPeer(BROWSER_NODE);
      await expect(h.service.open(input(BROWSER_NODE))).resolves.toMatchObject({ fundingAmount: INBOUND_CKB_AMOUNT });
    });

    it("keeps what open swaps reserve for their payouts out of the liquidity", async () => {
      const h = harness({ channels: [hubChannel({ channelId: channelId("a1"), localBalance: 2n * INBOUND_CKB_AMOUNT })] });
      h.node.connectPeer(BROWSER_NODE);
      h.store.createSwap(makeSwap({ direction: "ln_to_fiber", asset: "CKB", state: "pending", fiberAmount: 2n * INBOUND_CKB_AMOUNT - INBOUND_CKB_AMOUNT / 2n }));
      await hubErrorOf(h.service.open(input(BROWSER_NODE)), HttpStatus.UNPROCESSABLE_ENTITY, API_ERROR_CODE.INSUFFICIENT_LIQUIDITY);
    });

    it("reads liquidity only from ready channels in the same asset", async () => {
      const channels: FakeChannel[] = [
        hubChannel({ channelId: channelId("a1"), localBalance: 10n * INBOUND_CKB_AMOUNT, status: FIBER_CHANNEL_STATUS.OPENING }),
        hubChannel({ channelId: channelId("a2"), localBalance: 10n * INBOUND_CKB_AMOUNT, udtTypeScript: RUSD_SCRIPT }),
        hubChannel({ channelId: channelId("a3"), localBalance: 10n * INBOUND_CKB_AMOUNT, udtTypeScript: UNSERVED_UDT_SCRIPT }),
      ];
      const h = harness({ channels });
      h.node.connectPeer(BROWSER_NODE);
      await hubErrorOf(h.service.open(input(BROWSER_NODE, "CKB")), HttpStatus.UNPROCESSABLE_ENTITY, API_ERROR_CODE.INSUFFICIENT_LIQUIDITY);
    });
  });

  describe("open: the order of the checks (docs/architecture.md, Inbound channels)", () => {
    it("checks the daily caps before the connection", async () => {
      const h = harness({ env: { FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY: "1" } });
      h.node.connectPeer(BROWSER_NODE);
      await h.service.open(input(BROWSER_NODE));
      h.node.calls.length = 0;
      await hubErrorOf(h.service.open(input(SECOND_NODE)), HttpStatus.TOO_MANY_REQUESTS, API_ERROR_CODE.RATE_LIMITED);
      expect(h.node.calls).toEqual([]);
    });

    it("checks the connection before an existing channel", async () => {
      const existing = hubChannel({ channelId: channelId("b0"), peer: BROWSER_NODE, public: false });
      const h = harness({ channels: [...ROUTING_CHANNELS, existing] });
      const error = await hubErrorOf(h.service.open(input(BROWSER_NODE)), HttpStatus.CONFLICT, API_ERROR_CODE.CONFLICT);
      expect(error.message).toMatch(/not connected/);
    });

    it("checks an existing channel before the cap on open inbound channels", async () => {
      const existing = hubChannel({ channelId: channelId("b0"), peer: BROWSER_NODE, public: false });
      const h = harness({ env: { FIBER_INBOUND_MAX_OPEN: "1" }, channels: [...ROUTING_CHANNELS, existing] });
      h.node.connectPeer(BROWSER_NODE);
      await hubErrorOf(h.service.open(input(BROWSER_NODE)), HttpStatus.CONFLICT, API_ERROR_CODE.CONFLICT);
    });

    it("checks the cap on open inbound channels before liquidity", async () => {
      const other = hubChannel({ channelId: channelId("b0"), peer: THIRD_NODE, public: false });
      const h = harness({ env: { FIBER_INBOUND_MAX_OPEN: "1" }, channels: [hubChannel({ channelId: channelId("a1"), localBalance: 1n }), other] });
      h.node.connectPeer(BROWSER_NODE);
      await hubErrorOf(h.service.open(input(BROWSER_NODE)), HttpStatus.TOO_MANY_REQUESTS, API_ERROR_CODE.RATE_LIMITED);
    });
  });

  describe("open: daily caps", () => {
    it("caps a client at FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY channels a sliding day, whatever the nodes", async () => {
      const h = harness({ env: { FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY: "2", FIBER_INBOUND_MAX_PER_NODE_PER_DAY: "5" } });
      [BROWSER_NODE, SECOND_NODE, THIRD_NODE].forEach((node) => h.node.connectPeer(node));
      await h.service.open(input(BROWSER_NODE));
      h.clock.advance(MS_PER_HOUR);
      await h.service.open(input(SECOND_NODE));
      const error = (await hubErrorOf(h.service.open(input(THIRD_NODE)), HttpStatus.TOO_MANY_REQUESTS, API_ERROR_CODE.RATE_LIMITED)) as RateLimitedError;
      expect(error.retryAfterSeconds).toBe((MS_PER_DAY - MS_PER_HOUR) / MS_PER_SECOND);
      await expect(h.service.open(input(THIRD_NODE, "CKB", OTHER_CLIENT))).resolves.toMatchObject({ nodeId: THIRD_NODE });
    });

    it("lets the client again a full day after its oldest channel", async () => {
      const h = harness({ env: { FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY: "1" } });
      h.node.connectPeer(BROWSER_NODE);
      h.node.connectPeer(SECOND_NODE);
      await h.service.open(input(BROWSER_NODE));
      h.clock.advance(MS_PER_DAY - 1);
      await hubErrorOf(h.service.open(input(SECOND_NODE)), HttpStatus.TOO_MANY_REQUESTS, API_ERROR_CODE.RATE_LIMITED);
      h.clock.advance(1);
      await expect(h.service.open(input(SECOND_NODE))).resolves.toMatchObject({ nodeId: SECOND_NODE });
    });

    it("caps a node at FIBER_INBOUND_MAX_PER_NODE_PER_DAY whatever the client, counting 0x and upper-case ids as the same node", async () => {
      const h = harness({ env: { FIBER_INBOUND_MAX_PER_NODE_PER_DAY: "1" } });
      h.node.connectPeer(BROWSER_NODE);
      await h.service.open(input(BROWSER_NODE, "CKB", CLIENT));
      const error = await hubErrorOf(h.service.open(input(asTyped(BROWSER_NODE), "RUSD", OTHER_CLIENT)), HttpStatus.TOO_MANY_REQUESTS, API_ERROR_CODE.RATE_LIMITED);
      expect(error.message).toMatch(/this Fiber node/);
    });

    it("does not count a request refused by a check (not connected, conflict, liquidity)", async () => {
      const h = harness({ env: { FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY: "1", FIBER_INBOUND_MAX_PER_NODE_PER_DAY: "1" } });
      await hubErrorOf(h.service.open(input(BROWSER_NODE)), HttpStatus.CONFLICT, API_ERROR_CODE.CONFLICT);
      await hubErrorOf(h.service.open(input(BROWSER_NODE)), HttpStatus.CONFLICT, API_ERROR_CODE.CONFLICT);
      h.node.connectPeer(BROWSER_NODE);
      await expect(h.service.open(input(BROWSER_NODE))).resolves.toMatchObject({ nodeId: BROWSER_NODE });
    });

    it("does not count a channel fnn refused to open (nothing opened): 503 upstream_unavailable", async () => {
      const h = harness({ env: { FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY: "1", FIBER_INBOUND_MAX_PER_NODE_PER_DAY: "1" } });
      h.node.connectPeer(BROWSER_NODE);
      h.node.failNext = "openChannel";
      const error = await hubErrorOf(h.service.open(input(BROWSER_NODE)), HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
      expect(error.message).not.toMatch(/simulated/);
      expect(await channelsTo(h.node, BROWSER_NODE)).toEqual([]);
      await expect(h.service.open(input(BROWSER_NODE))).resolves.toMatchObject({ nodeId: BROWSER_NODE });
    });

    it("counts an open whose answer was lost (the channel may be opening), and passes the node's 503 on", async () => {
      const h = harness({ env: { FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY: "1", FIBER_INBOUND_MAX_PER_NODE_PER_DAY: "5" } });
      h.node.connectPeer(BROWSER_NODE);
      h.node.connectPeer(SECOND_NODE);
      h.node.loseNextOpenChannelAnswer = true;
      await hubErrorOf(h.service.open(input(BROWSER_NODE)), HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE, false);
      expect(await channelsTo(h.node, BROWSER_NODE)).toHaveLength(1);
      await hubErrorOf(h.service.open(input(SECOND_NODE)), HttpStatus.TOO_MANY_REQUESTS, API_ERROR_CODE.RATE_LIMITED);
    });

    it("answers 503 upstream_unavailable when the node does not answer a check", async () => {
      const h = harness();
      h.node.connectPeer(BROWSER_NODE);
      h.node.failNext = "isConnected";
      await hubErrorOf(h.service.open(input(BROWSER_NODE)), HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
      h.node.failNext = "listChannelDetails";
      await hubErrorOf(h.service.open(input(BROWSER_NODE)), HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
      expect(h.node.calls).not.toContain("openChannel");
      await expect(h.service.open(input(BROWSER_NODE))).resolves.toMatchObject({ nodeId: BROWSER_NODE });
    });
  });

  describe("open: one at a time", () => {
    /** Makes isConnected answer late, so two requests would both pass the checks if they ran side by side. */
    const slowConnectionCheck = (node: FakeFiberNode): void => {
      const original = node.isConnected.bind(node);
      jest.spyOn(node, "isConnected").mockImplementation(async (nodeId) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return original(nodeId);
      });
    };

    it("opens one channel when the same node asks twice at once: the second is a 409 conflict", async () => {
      const h = harness();
      h.node.connectPeer(BROWSER_NODE);
      slowConnectionCheck(h.node);
      const results = await Promise.allSettled([h.service.open(input(BROWSER_NODE)), h.service.open(input(BROWSER_NODE, "CKB", OTHER_CLIENT))]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ status: HttpStatus.CONFLICT });
      expect(await channelsTo(h.node, BROWSER_NODE)).toHaveLength(1);
    });

    it("keeps FIBER_INBOUND_MAX_OPEN when two nodes ask at once", async () => {
      const h = harness({ env: { FIBER_INBOUND_MAX_OPEN: "1" } });
      h.node.connectPeer(BROWSER_NODE);
      h.node.connectPeer(SECOND_NODE);
      slowConnectionCheck(h.node);
      const results = await Promise.allSettled([h.service.open(input(BROWSER_NODE)), h.service.open(input(SECOND_NODE, "CKB", OTHER_CLIENT))]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    });

    it("keeps the per-client cap when one client asks for two nodes at once", async () => {
      const h = harness({ env: { FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY: "1" } });
      h.node.connectPeer(BROWSER_NODE);
      h.node.connectPeer(SECOND_NODE);
      slowConnectionCheck(h.node);
      const results = await Promise.allSettled([h.service.open(input(BROWSER_NODE)), h.service.open(input(SECOND_NODE))]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    });

    it("goes on after a failed open", async () => {
      const h = harness();
      h.node.connectPeer(SECOND_NODE);
      const results = await Promise.allSettled([h.service.open(input(BROWSER_NODE)), h.service.open(input(SECOND_NODE, "CKB", OTHER_CLIENT))]);
      expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    });
  });

  describe("list", () => {
    it("lists the channels the hub's node opened to the node that are not closed, in served assets, with both balances", async () => {
      const channels: FakeChannel[] = [
        ...ROUTING_CHANNELS,
        hubChannel({ channelId: channelId("d1"), peer: BROWSER_NODE, public: false, localBalance: 400n * ONE_CKB, remoteBalance: 3n * ONE_CKB }),
        hubChannel({ channelId: channelId("d2"), peer: BROWSER_NODE, public: false, udtTypeScript: RUSD_SCRIPT, status: FIBER_CHANNEL_STATUS.OPENING, localBalance: INBOUND_RUSD_AMOUNT }),
        hubChannel({ channelId: channelId("d3"), peer: BROWSER_NODE, public: false, status: FIBER_CHANNEL_STATUS.CLOSING, localBalance: 1n }),
        hubChannel({ channelId: channelId("d4"), peer: BROWSER_NODE, public: false, status: FIBER_CHANNEL_STATUS.CLOSED }),
        hubChannel({ channelId: channelId("d5"), peer: BROWSER_NODE, public: false, openedByPeer: true }),
        hubChannel({ channelId: channelId("d6"), peer: BROWSER_NODE, public: false, udtTypeScript: UNSERVED_UDT_SCRIPT }),
        hubChannel({ channelId: channelId("d7"), peer: SECOND_NODE, public: false }),
      ];
      const h = harness({ channels });
      expect(await h.service.list(BROWSER_NODE)).toEqual([
        { channelId: channelId("d1"), asset: "CKB", state: "ready", hubBalance: 400n * ONE_CKB, nodeBalance: 3n * ONE_CKB },
        { channelId: channelId("d2"), asset: "RUSD", state: "opening", hubBalance: INBOUND_RUSD_AMOUNT, nodeBalance: 0n },
        { channelId: channelId("d3"), asset: "CKB", state: "closing", hubBalance: 1n, nodeBalance: 0n },
      ]);
    });

    it("asks the node only for the channels with that peer, by its normalised id", async () => {
      const h = harness();
      const list = jest.spyOn(h.node, "listChannelDetails");
      await h.service.list(asTyped(BROWSER_NODE));
      expect(list).toHaveBeenCalledWith(BROWSER_NODE);
    });

    it("is empty for a node the hub has no channel with", async () => {
      await expect(harness().service.list(SECOND_NODE)).resolves.toEqual([]);
    });

    it("shows a channel the hub just opened as opening, then ready once the peer accepts it", async () => {
      const h = harness();
      h.node.connectPeer(BROWSER_NODE);
      const opening = await h.service.open(input(BROWSER_NODE));
      expect(await h.service.list(BROWSER_NODE)).toEqual([
        { channelId: opening.temporaryChannelId, asset: "CKB", state: "opening", hubBalance: INBOUND_CKB_AMOUNT, nodeBalance: 0n },
      ]);
      h.node.completeChannelOpenings();
      expect(await h.service.list(BROWSER_NODE)).toMatchObject([{ state: "ready", hubBalance: INBOUND_CKB_AMOUNT }]);
    });

    it("answers 503 upstream_unavailable when the node does not answer", async () => {
      const h = harness();
      h.node.failNext = "listChannelDetails";
      await hubErrorOf(h.service.list(BROWSER_NODE), HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
    });
  });
});
