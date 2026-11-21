import { OperatorEvents, type OperatorEvent } from "../../../src/application/monitoring/operator-events";
import type { FiberOfferedTlc } from "../../../src/application/ports/fiber.port";
import { SwapEngineService } from "../../../src/application/swaps/swap-engine.service";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import { hours, makeSwapHarness, payHoldInvoice, processPasses, processToRest, silenceLogs, startSwap, type SwapHarness } from "./swaps.fixtures";

/**
 * The swap processor reports the payout guard to the hub's monitor through the engine's optional OperatorEvents
 * (MonitoringModule provides it): payout-guard-closed for each channel it force-closes, payout-guard-failed when it
 * cannot check a payout. The payout guard itself is specified in swap-engine.payout-guard.spec.ts.
 */

const PRIVATE_CHANNEL = `0x${"a1".repeat(32)}`;
const PAYEE = `03${"cd".repeat(32)}`;
/** How long the payee's TLC lives after the payout is sent, and when, in between, the guard closes it. */
const TLC_LIFETIME_MS = hours(7);
const CLOSE_CHECK_AFTER_MS = hours(2);

describe("swap engine: payout guard events for the monitor", () => {
  let h: SwapHarness;
  let heard: OperatorEvent[];

  beforeEach(() => {
    silenceLogs();
    h = makeSwapHarness();
    const events = new OperatorEvents();
    heard = [];
    events.on((event) => heard.push(event));
    h.engine = new SwapEngineService(h.hubLn, h.hubFiber, h.store, h.pricing, h.assets, h.config.timing, h.clock, h.config, events);
  });
  afterEach(() => jest.restoreAllMocks());

  const offered = (expiresAt: number): Omit<FiberOfferedTlc, "paymentHash"> => ({
    expiresAt,
    channelId: PRIVATE_CHANNEL,
    peer: PAYEE,
    channelPublic: false,
    channelOpenedByPeer: false,
  });

  /** An ln_to_fiber swap whose payout hangs with the payee holding the TLC, at the time the guard closes its channel. */
  async function holdingPayee() {
    const started = await startSwap(h, "ln_to_fiber");
    const hash = sha256Hex(started.preimage);
    h.fiberNet.setPayoutBehavior(hash, "hang");
    await payHoldInvoice(h, started.swap);
    const sentAt = h.clock.now();
    expect((await processPasses(h, started.swap.id, 2)).state).toBe("outgoing_in_flight");
    h.hubFiber.setOfferedTlcs(hash, [offered(sentAt + TLC_LIFETIME_MS)]);
    h.clock.set(sentAt + CLOSE_CHECK_AFTER_MS);
    return started.swap;
  }

  it("emits payout-guard-closed with the swap and the channel when the guard force-closes it", async () => {
    const swap = await holdingPayee();

    await processPasses(h, swap.id, 1);

    expect(h.hubFiber.forceClosedChannels).toEqual([PRIVATE_CHANNEL]);
    expect(heard).toEqual([{ kind: "payout-guard-closed", swapId: swap.id, channelId: PRIVATE_CHANNEL }]);
  });

  it("emits it once per channel closed, not on every later pass", async () => {
    const swap = await holdingPayee();

    await processPasses(h, swap.id, 3);

    expect(heard.filter((event) => event.kind === "payout-guard-closed")).toHaveLength(1);
  });

  it("emits payout-guard-failed with the swap and the reason when it cannot read the payout's channels", async () => {
    const swap = await holdingPayee();
    h.hubFiber.failNext = "offeredTlcs";

    await processPasses(h, swap.id, 1);

    expect(heard).toEqual([{ kind: "payout-guard-failed", swapId: swap.id, detail: expect.stringContaining("offeredTlcs: simulated transport error") }]);
  });

  it("emits nothing while a payout settles normally", async () => {
    const { swap } = await startSwap(h, "ln_to_fiber");
    await payHoldInvoice(h, swap);

    expect((await processToRest(h, swap.id)).state).toBe("succeeded");
    expect(heard).toEqual([]);
  });
});
