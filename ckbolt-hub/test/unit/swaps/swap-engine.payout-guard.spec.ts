import { FIBER_PAYOUT_GUARD } from "../../../src/common/constants/timing.constants";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import { fiberPayoutForceCloseAt, slowCommitmentDelayMs } from "../../../src/domain/timing/timing.budget";
import type { FiberOfferedTlc } from "../../../src/application/ports/fiber.port";
import {
  callCount,
  hours,
  makeSwapHarness,
  minutes,
  payHoldInvoice,
  processPasses,
  processToRest,
  silenceLogs,
  startSwap,
  type LogSpies,
  type SwapHarness,
} from "./swaps.fixtures";

/**
 * The ln_to_fiber payout guard (FIBER_PAYOUT_GUARD, SwapFlow.guardPayout): fnn lets a payee claim the hub's TLC on chain
 * with the preimage even after it expires, and on-chain settlement opens only a commitment delay after a force close.
 * While the payout is in flight, the hub force-closes a channel whose peer still holds the TLC at
 * fiberPayoutForceCloseAt, so settlement opens before the TLC expires, while the Lightning hold still stands. Only a
 * public channel the hub opened to a router that is not the payee stays open. It never touches the incoming leg, and a
 * failure to look is retried on the next pass.
 */

const PRIVATE_CHANNEL = `0x${"a1".repeat(32)}`;
const PUBLIC_CHANNEL = `0x${"b2".repeat(32)}`;
const PAYEE_PUBLIC_CHANNEL = `0x${"c3".repeat(32)}`;
/** The peer of the default private channel. On a public channel it stands for a router: the payout invoice's payee is h.userFiber. */
const PAYEE = `03${"cd".repeat(32)}`;
/** fnn's default commitment delay (1 epoch of 4 h), counted 25 % longer, plus the 30-minute margin. */
const DEFAULT_LEAD_MS = hours(5) + minutes(30);

describe("fiberPayoutForceCloseAt", () => {
  const sentAt = 1_000_000;

  it("counts a commitment delay 25 % longer than its 4-hour epochs", () => {
    expect(slowCommitmentDelayMs(1)).toBe(hours(5));
    expect(slowCommitmentDelayMs(84)).toBe(hours(420));
  });

  it("closes the delay plus the margin before the expiry, so settlement opens 30 minutes before it", () => {
    const expiresAt = sentAt + hours(7);
    expect(fiberPayoutForceCloseAt({ expiresAt, commitmentDelayEpochs: 1, sentAt })).toBe(expiresAt - DEFAULT_LEAD_MS);
    expect(DEFAULT_LEAD_MS).toBe(slowCommitmentDelayMs(1) + FIBER_PAYOUT_GUARD.marginMs);
  });

  it("never sooner than the grace after the payout was sent", () => {
    expect(fiberPayoutForceCloseAt({ expiresAt: sentAt + hours(5), commitmentDelayEpochs: 1, sentAt })).toBe(sentAt + FIBER_PAYOUT_GUARD.settleGraceMs);
    expect(fiberPayoutForceCloseAt({ expiresAt: sentAt + hours(7), commitmentDelayEpochs: 84, sentAt })).toBe(sentAt + minutes(10));
  });
});

describe("swap engine: the ln_to_fiber payout guard", () => {
  let h: SwapHarness;
  let logs: LogSpies;

  beforeEach(() => {
    logs = silenceLogs();
    h = makeSwapHarness();
  });
  afterEach(() => jest.restoreAllMocks());

  const holdState = async (hash: string) => (await h.hubLn.lookupInvoice(hash))?.state;
  const offered = (patch: Partial<Omit<FiberOfferedTlc, "paymentHash">> = {}): Omit<FiberOfferedTlc, "paymentHash"> => ({
    expiresAt: h.clock.now() + hours(7),
    channelId: PRIVATE_CHANNEL,
    peer: PAYEE,
    channelPublic: false,
    channelOpenedByPeer: false,
    ...patch,
  });

  /** An ln_to_fiber swap whose payout hangs: sent, in flight, the payee holding the TLC. Returns it and when it was sent. */
  async function holdingPayee() {
    const started = await startSwap(h, "ln_to_fiber");
    const hash = sha256Hex(started.preimage);
    h.fiberNet.setPayoutBehavior(hash, "hang");
    await payHoldInvoice(h, started.swap);
    const sentAt = h.clock.now();
    expect((await processPasses(h, started.swap.id, 2)).state).toBe("outgoing_in_flight");
    return { ...started, hash, sentAt };
  }

  it("leaves the channel open before the force-close point, and closes it once there, without touching the hold", async () => {
    const { swap, hash, sentAt } = await holdingPayee();
    const expiresAt = sentAt + hours(7);
    h.hubFiber.setOfferedTlcs(hash, [offered({ expiresAt })]);

    h.clock.set(expiresAt - DEFAULT_LEAD_MS - minutes(1));
    await processPasses(h, swap.id, 3);
    expect(h.hubFiber.forceClosedChannels).toEqual([]);

    h.clock.set(expiresAt - DEFAULT_LEAD_MS);
    const after = await processPasses(h, swap.id, 3);
    expect(h.hubFiber.forceClosedChannels).toEqual([PRIVATE_CHANNEL]);
    expect(after.state).toBe("outgoing_in_flight");
    expect(after.refunded).toBe(false);
    expect(await holdState(hash)).toBe("ACCEPTED");
    expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
    expect(callCount(h.hubLn, "settleInvoice")).toBe(0);
    expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining(`force-closed channel ${PRIVATE_CHANNEL}`));
  });

  it("collects the hold when the payee then claims with the preimage on chain (fnn reports it as the payment's)", async () => {
    const { swap, hash, sentAt, preimage } = await holdingPayee();
    h.hubFiber.setOfferedTlcs(hash, [offered({ expiresAt: sentAt + hours(7) })]);
    h.clock.set(sentAt + hours(2));
    await processPasses(h, swap.id, 1);
    expect(h.hubFiber.forceClosedChannels).toEqual([PRIVATE_CHANNEL]);

    h.fiberNet.resolveHanging(hash, "succeed");
    const done = await processToRest(h, swap.id);
    expect(done).toMatchObject({ state: "succeeded", preimage, refunded: false });
    expect(await holdState(hash)).toBe("SETTLED");
  });

  it("leaves open a public channel the hub opened to a router that is not the payee: the router answers to its payee first", async () => {
    const { swap, hash, sentAt } = await holdingPayee();
    h.hubFiber.setOfferedTlcs(hash, [offered({ channelId: PUBLIC_CHANNEL, channelPublic: true, expiresAt: sentAt + hours(7) })]);
    h.clock.set(sentAt + hours(6));
    await processPasses(h, swap.id, 3);
    expect(h.hubFiber.forceClosedChannels).toEqual([]);
    expect(callCount(h.hubFiber, "forceCloseChannel")).toBe(0);
  });

  it("closes a public channel whose peer is the payee itself, at the same point as a private one", async () => {
    const { swap, hash, sentAt } = await holdingPayee();
    const expiresAt = sentAt + hours(7);
    h.hubFiber.setOfferedTlcs(hash, [offered({ channelId: PUBLIC_CHANNEL, channelPublic: true, peer: h.userFiber.nodeId, expiresAt })]);

    h.clock.set(expiresAt - DEFAULT_LEAD_MS - minutes(1));
    await processPasses(h, swap.id, 2);
    expect(h.hubFiber.forceClosedChannels).toEqual([]);

    h.clock.set(expiresAt - DEFAULT_LEAD_MS);
    const after = await processPasses(h, swap.id, 2);
    expect(h.hubFiber.forceClosedChannels).toEqual([PUBLIC_CHANNEL]);
    expect(after).toMatchObject({ state: "outgoing_in_flight", refunded: false });
    expect(await holdState(hash)).toBe("ACCEPTED");
  });

  it("closes a public channel a peer opened, whoever the payee: anyone can open one to the hub and route through it", async () => {
    const { swap, hash, sentAt } = await holdingPayee();
    h.hubFiber.setOfferedTlcs(hash, [offered({ channelId: PUBLIC_CHANNEL, channelPublic: true, channelOpenedByPeer: true, expiresAt: sentAt + hours(7) })]);

    h.clock.set(sentAt + FIBER_PAYOUT_GUARD.settleGraceMs - minutes(1));
    await processPasses(h, swap.id, 1);
    expect(h.hubFiber.forceClosedChannels).toEqual([]);

    h.clock.set(sentAt + FIBER_PAYOUT_GUARD.settleGraceMs);
    await processPasses(h, swap.id, 1);
    expect(h.hubFiber.forceClosedChannels).toEqual([PUBLIC_CHANNEL]);
  });

  it("reads the payout invoice's payee only when a due TLC is on a routing channel the hub opened", async () => {
    const { swap, hash, sentAt } = await holdingPayee();
    h.hubFiber.setOfferedTlcs(hash, [offered({ expiresAt: sentAt + hours(7) })]);
    const parsedBefore = callCount(h.hubFiber, "parseInvoice");
    h.clock.set(sentAt + hours(2));
    await processPasses(h, swap.id, 2);
    expect(h.hubFiber.forceClosedChannels).toEqual([PRIVATE_CHANNEL]);
    expect(callCount(h.hubFiber, "parseInvoice")).toBe(parsedBefore);

    h.hubFiber.setOfferedTlcs(hash, [offered({ channelId: PUBLIC_CHANNEL, channelPublic: true, expiresAt: sentAt + hours(7) })]);
    await processPasses(h, swap.id, 1);
    expect(callCount(h.hubFiber, "parseInvoice")).toBeGreaterThan(parsedBefore);
  });

  it("closes the payee's channel and leaves the router's open when one pass sees both", async () => {
    const { swap, hash, sentAt } = await holdingPayee();
    const expiresAt = sentAt + hours(7);
    h.hubFiber.setOfferedTlcs(hash, [
      offered({ channelId: PUBLIC_CHANNEL, channelPublic: true, expiresAt }),
      offered({ channelId: PAYEE_PUBLIC_CHANNEL, channelPublic: true, peer: h.userFiber.nodeId, expiresAt }),
    ]);
    h.clock.set(expiresAt - DEFAULT_LEAD_MS);
    await processPasses(h, swap.id, 2);
    expect(h.hubFiber.forceClosedChannels).toEqual([PAYEE_PUBLIC_CHANNEL]);
  });

  it("a failure to read the payout invoice is logged and retried; the swap stays as it is", async () => {
    const { swap, hash, sentAt } = await holdingPayee();
    h.hubFiber.setOfferedTlcs(hash, [offered({ channelId: PUBLIC_CHANNEL, channelPublic: true, peer: h.userFiber.nodeId, expiresAt: sentAt + hours(7) })]);
    h.clock.set(sentAt + hours(2));
    h.hubFiber.failNext = "parseInvoice";

    const after = await processPasses(h, swap.id, 1);
    expect(after.state).toBe("outgoing_in_flight");
    expect(h.hubFiber.forceClosedChannels).toEqual([]);
    expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining("could not check the payout's channels"));

    await processPasses(h, swap.id, 1);
    expect(h.hubFiber.forceClosedChannels).toEqual([PUBLIC_CHANNEL]);
  });

  it("counts a channel the peer opened with the delay assumed for peer channels: closes after the grace", async () => {
    const { swap, hash, sentAt } = await holdingPayee();
    h.hubFiber.setOfferedTlcs(hash, [offered({ channelOpenedByPeer: true, expiresAt: sentAt + hours(7) })]);

    h.clock.set(sentAt + FIBER_PAYOUT_GUARD.settleGraceMs - minutes(1));
    await processPasses(h, swap.id, 1);
    expect(h.hubFiber.forceClosedChannels).toEqual([]);

    h.clock.set(sentAt + FIBER_PAYOUT_GUARD.settleGraceMs);
    await processPasses(h, swap.id, 1);
    expect(h.hubFiber.forceClosedChannels).toEqual([PRIVATE_CHANNEL]);
  });

  it("closes a channel once, even with several TLCs on it and further passes", async () => {
    const { swap, hash, sentAt } = await holdingPayee();
    h.hubFiber.setOfferedTlcs(hash, [offered({ expiresAt: sentAt + hours(7) }), offered({ expiresAt: sentAt + hours(7) + minutes(5) })]);
    h.clock.set(sentAt + hours(3));
    await processPasses(h, swap.id, 4);
    expect(h.hubFiber.forceClosedChannels).toEqual([PRIVATE_CHANNEL]);
  });

  it("a failure to read the channels is logged and retried; the swap stays as it is", async () => {
    const { swap, hash, sentAt } = await holdingPayee();
    h.hubFiber.setOfferedTlcs(hash, [offered({ expiresAt: sentAt + hours(7) })]);
    h.clock.set(sentAt + hours(2));
    h.hubFiber.failNext = "offeredTlcs";

    const after = await processPasses(h, swap.id, 1);
    expect(after.state).toBe("outgoing_in_flight");
    expect(h.hubFiber.forceClosedChannels).toEqual([]);
    expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining("could not check the payout's channels"));

    await processPasses(h, swap.id, 1);
    expect(h.hubFiber.forceClosedChannels).toEqual([PRIVATE_CHANNEL]);
  });

  it("does nothing while the payout settles normally", async () => {
    const { swap } = await startSwap(h, "ln_to_fiber");
    await payHoldInvoice(h, swap);
    expect((await processToRest(h, swap.id)).state).toBe("succeeded");
    expect(callCount(h.hubFiber, "forceCloseChannel")).toBe(0);
  });

  it("fiber_to_ln never looks at Fiber channels: LND guards its own HTLC", async () => {
    const { swap, preimage } = await startSwap(h, "fiber_to_ln");
    h.lnNet.setPayoutBehavior(sha256Hex(preimage), "hang");
    await payHoldInvoice(h, swap);
    expect((await processPasses(h, swap.id, 3)).state).toBe("outgoing_in_flight");
    h.clock.set(h.clock.now() + hours(3));
    await processPasses(h, swap.id, 2);
    expect(callCount(h.hubFiber, "offeredTlcs")).toBe(0);
    expect(callCount(h.hubFiber, "forceCloseChannel")).toBe(0);
  });
});
