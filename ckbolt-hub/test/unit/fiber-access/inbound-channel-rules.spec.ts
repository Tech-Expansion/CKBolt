import { HttpStatus } from "@nestjs/common";
import { ChannelOpenCaps, type ChannelOpenLimits, type ChannelOpenRequest } from "../../../src/application/channel-opens/channel-open-caps";
import { FIBER_NODE_ERROR } from "../../../src/application/fiber-node/fiber-node.errors";
import { inboundOffers, isInboundChannel, isLiveChannel, isOpenedByHub } from "../../../src/application/fiber-node/inbound-channel.rules";
import type { FiberChannel } from "../../../src/application/ports/fiber.port";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { CHANNEL_OPEN_CAP_WINDOW_MS, CHANNEL_OPEN_KIND } from "../../../src/common/constants/channel-opens.constants";
import { FIBER_CHANNEL_STATUS } from "../../../src/common/constants/fiber-node.constants";
import { MS_PER_DAY, MS_PER_SECOND } from "../../../src/common/constants/protocol.constants";
import { RateLimitedError } from "../../../src/common/errors/hub.error";
import { createAssetRegistry } from "../../../src/domain/assets";
import { FakeChannelOpenLog } from "../../fakes";
import {
  BROWSER_NODE,
  INBOUND_CKB_AMOUNT,
  INBOUND_RUSD_AMOUNT,
  RUSD_SCRIPT,
  SECOND_NODE,
  THIRD_NODE,
  assetsOf,
  channelId,
  hubChannel,
  inboundConfig,
} from "./fiber-access.fixtures";

/** The pure rules of inbound channels, and the daily caps (ChannelOpenCaps) as inbound Fiber channels use them. */

const channel = (overrides: Partial<FiberChannel>): FiberChannel => hubChannel({ channelId: channelId("c1"), ...overrides }) as FiberChannel;

describe("inboundOffers", () => {
  it("offers each served asset that has an amount, in the registry's order, with the exact amount", () => {
    const config = inboundConfig();
    const offers = inboundOffers(config.fiberPeers.inboundChannels, assetsOf(config));
    expect(offers.map((offer) => [offer.asset.id, offer.amount])).toEqual([
      ["CKB", INBOUND_CKB_AMOUNT],
      ["RUSD", INBOUND_RUSD_AMOUNT],
    ]);
    expect(offers[1]?.asset.udtTypeScript).toEqual(RUSD_SCRIPT);
  });

  it("offers nothing when inbound channels are off, whatever the amounts", () => {
    const config = inboundConfig({ FIBER_INBOUND_ENABLED: "false" });
    expect(inboundOffers(config.fiberPeers.inboundChannels, assetsOf(config))).toEqual([]);
  });

  it("leaves out an asset with an amount that the hub does not serve on its network", () => {
    const config = inboundConfig();
    const ckbOnlyRegistry = createAssetRegistry("devnet");
    expect(inboundOffers(config.fiberPeers.inboundChannels, ckbOnlyRegistry).map((offer) => offer.asset.id)).toEqual(["CKB"]);
  });

  it("leaves out a served asset without an amount", () => {
    const config = inboundConfig();
    const settings = { ...config.fiberPeers.inboundChannels, amounts: { RUSD: 7n } };
    expect(inboundOffers(settings, assetsOf(config)).map((offer) => [offer.asset.id, offer.amount])).toEqual([["RUSD", 7n]]);
  });
});

describe("channel rules", () => {
  it.each([
    [FIBER_CHANNEL_STATUS.OPENING, true],
    [FIBER_CHANNEL_STATUS.READY, true],
    [FIBER_CHANNEL_STATUS.CLOSING, true],
    [FIBER_CHANNEL_STATUS.CLOSED, false],
  ])("a %s channel is live: %s", (status, live) => {
    expect(isLiveChannel(channel({ status }))).toBe(live);
  });

  it("counts as opened by the hub only a live channel the hub's node opened", () => {
    expect(isOpenedByHub(channel({ openedByPeer: false }))).toBe(true);
    expect(isOpenedByHub(channel({ openedByPeer: true }))).toBe(false);
    expect(isOpenedByHub(channel({ openedByPeer: false, status: FIBER_CHANNEL_STATUS.CLOSED }))).toBe(false);
  });

  it("counts as an inbound channel only a live, private channel the hub opened (its routing channels are public)", () => {
    expect(isInboundChannel(channel({ public: false, status: FIBER_CHANNEL_STATUS.OPENING }))).toBe(true);
    expect(isInboundChannel(channel({ public: false, status: FIBER_CHANNEL_STATUS.CLOSING }))).toBe(true);
    expect(isInboundChannel(channel({ public: true }))).toBe(false);
    expect(isInboundChannel(channel({ public: false, openedByPeer: true }))).toBe(false);
    expect(isInboundChannel(channel({ public: false, status: FIBER_CHANNEL_STATUS.CLOSED }))).toBe(false);
  });
});

describe("ChannelOpenCaps with the inbound Fiber refusals (per client and per node over a sliding day, every client per UTC day)", () => {
  const T0 = Date.UTC(2026, 9, 23, 12, 0, 0);
  /** High enough that the UTC day's cap stays out of the way of the sliding-day tests. */
  const NO_DAY_CAP = 1_000;

  const caps = (limits: Partial<ChannelOpenLimits>, log: FakeChannelOpenLog = new FakeChannelOpenLog()): ChannelOpenCaps =>
    new ChannelOpenCaps(log, CHANNEL_OPEN_KIND.FIBER, { perClient: 10, perPeer: 10, perDay: NO_DAY_CAP, ...limits }, {
      client: FIBER_NODE_ERROR.tooManyFromClient,
      peer: FIBER_NODE_ERROR.tooManyForNode,
      day: FIBER_NODE_ERROR.tooManyToday,
    });

  const request = (clientKey: string, peer: string): ChannelOpenRequest => ({ clientKey, peer, pushedSats: 0n });
  const record = (limits: ChannelOpenCaps, client: string, node: string, now: number): void => limits.record(request(client, node), now);
  const assertAllowed = (limits: ChannelOpenCaps, client: string, node: string, now: number): void => limits.assertAllowed(request(client, node), now);

  function refusal(limits: ChannelOpenCaps, client: string, node: string, now: number): RateLimitedError {
    try {
      assertAllowed(limits, client, node, now);
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitedError);
      return error as RateLimitedError;
    }
    throw new Error("expected a 429");
  }

  it("counts over exactly one day", () => {
    expect(CHANNEL_OPEN_CAP_WINDOW_MS).toBe(MS_PER_DAY);
  });

  it("allows up to the per-client cap, then refuses with 429 rate_limited and the seconds until the oldest leaves the day", () => {
    const limits = caps({ perClient: 2, perPeer: 10 });
    record(limits, "client", BROWSER_NODE, T0);
    record(limits, "client", SECOND_NODE, T0 + 10 * MS_PER_SECOND);
    const error = refusal(limits, "client", `03${"99".repeat(32)}`, T0 + 60 * MS_PER_SECOND);
    expect(error).toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS, code: API_ERROR_CODE.RATE_LIMITED });
    expect(error.retryAfterSeconds).toBe((MS_PER_DAY - 60 * MS_PER_SECOND) / MS_PER_SECOND);
    expect(error.message).toMatch(/client.*2 inbound channels/);
  });

  it("allows the client again once its oldest channel is a full day old, not a millisecond before", () => {
    const limits = caps({ perClient: 1, perPeer: 10 });
    record(limits, "client", BROWSER_NODE, T0);
    expect(refusal(limits, "client", SECOND_NODE, T0 + MS_PER_DAY - 1).retryAfterSeconds).toBe(1);
    expect(() => assertAllowed(limits, "client", SECOND_NODE, T0 + MS_PER_DAY)).not.toThrow();
  });

  it("caps each node whatever the client, and says it is the node's cap", () => {
    const limits = caps({ perClient: 10, perPeer: 1 });
    record(limits, "client-a", BROWSER_NODE, T0);
    const error = refusal(limits, "client-b", BROWSER_NODE, T0 + 1);
    expect(error.message).toMatch(/this Fiber node/);
    expect(() => assertAllowed(limits, "client-b", SECOND_NODE, T0 + 1)).not.toThrow();
  });

  it("checks the client before the node", () => {
    const limits = caps({ perClient: 1, perPeer: 1 });
    record(limits, "client", BROWSER_NODE, T0);
    expect(refusal(limits, "client", BROWSER_NODE, T0 + 1).message).toMatch(/This client/);
  });

  it("asks for at least one second, never 0", () => {
    const limits = caps({ perClient: 1, perPeer: 10 });
    record(limits, "client", BROWSER_NODE, T0);
    expect(refusal(limits, "client", SECOND_NODE, T0 + MS_PER_DAY - 1).retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("does not count a refused request: only record() counts", () => {
    const limits = caps({ perClient: 1, perPeer: 1 });
    for (let i = 0; i < 5; i += 1) expect(() => assertAllowed(limits, "client", BROWSER_NODE, T0 + i)).not.toThrow();
    record(limits, "client", BROWSER_NODE, T0 + 10);
    expect(() => assertAllowed(limits, "client", BROWSER_NODE, T0 + 11)).toThrow(RateLimitedError);
  });

  it("keeps clients apart", () => {
    const limits = caps({ perClient: 1, perPeer: 10 });
    record(limits, "client-a", BROWSER_NODE, T0);
    expect(() => assertAllowed(limits, "client-b", SECOND_NODE, T0)).not.toThrow();
  });

  it("caps every client together at perDay opens in the UTC day, with Retry-After until midnight UTC", () => {
    const limits = caps({ perDay: 2 });
    record(limits, "client-a", BROWSER_NODE, T0);
    record(limits, "client-b", SECOND_NODE, T0 + 1);
    const error = refusal(limits, "client-c", THIRD_NODE, T0 + 2);
    expect(error.message).toMatch(/2 inbound channels it opens in a day/);
    expect(error.retryAfterSeconds).toBe(Math.ceil((Date.UTC(2026, 9, 24) - (T0 + 2)) / MS_PER_SECOND));
    expect(() => assertAllowed(limits, "client-c", THIRD_NODE, Date.UTC(2026, 9, 24))).not.toThrow();
  });

  it("keeps the counts in the log it is given, so a new instance over the same log (a restart) still refuses", () => {
    const log = new FakeChannelOpenLog();
    record(caps({ perClient: 1 }, log), "client", BROWSER_NODE, T0);
    expect(refusal(caps({ perClient: 1 }, log), "client", SECOND_NODE, T0 + 1).message).toMatch(/This client/);
  });

  it("forgets the opens from before the last day when it records one (no cap counts them any more)", () => {
    const log = new FakeChannelOpenLog();
    const limits = caps({}, log);
    record(limits, "client", BROWSER_NODE, T0);
    record(limits, "client", SECOND_NODE, T0 + MS_PER_DAY);
    expect(log.all().map((open) => open.peer)).toEqual([BROWSER_NODE, SECOND_NODE]);
    record(limits, "client", THIRD_NODE, T0 + MS_PER_DAY + 1);
    expect(log.all().map((open) => open.peer)).toEqual([SECOND_NODE, THIRD_NODE]);
  });
});
