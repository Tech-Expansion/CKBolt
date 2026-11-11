import { randomBytes } from "node:crypto";
import { FIBER_MIN_FINAL_EXPIRY_DELTA_MS } from "../../../src/common/constants/protocol.constants";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import { loadHubConfig } from "../../../src/config/hub.config";
import {
  checkLnToFiberPayout,
  lnPayoutCltvLimit,
  lnSettleDeadlineHeight,
  planFiberToLn,
  planLnToFiber,
} from "../../../src/domain/timing/timing.policy";
import { FakeClock, FakeFiberNetwork, FakeLightningNetwork } from "../../fakes";
import { expectPlan, expectRefusal, failsAtOnDefaultChannel, fastBlockMs, minutes, slowBlockMs } from "./timing.fixtures";

/**
 * The timing policy driven through the fake LND and fnn nodes (which auto-cancel and early-fail like the real ones),
 * with profiles loaded from config the way HubConfigModule provides them. Each scenario plays the worst case the policy
 * must survive: the outgoing payment takes its whole lock while the incoming deadline arrives as fast as the profile
 * allows.
 */

const START_HEIGHT = 200;
const SWAP_SATS = 10_000n;
const SWAP_SHANNONS = 100n * 10n ** 8n;
const MAX_FEE_SATS = 10n;
const PAY_TIMEOUT_SECONDS = 60;

const newPreimage = () => randomBytes(32).toString("hex");

function world() {
  const clock = new FakeClock();
  const ln = new FakeLightningNetwork("regtest", clock, START_HEIGHT);
  const fiber = new FakeFiberNetwork("devnet", clock);
  return {
    clock,
    ln,
    fiber,
    hubLn: ln.node("hub"),
    userLn: ln.node("user"),
    hubFiber: fiber.node("hub"),
    userFiber: fiber.node("user"),
  };
}

describe("timing scenarios: ln_to_fiber (user pays Lightning, hub pays Fiber)", () => {
  async function acceptedSwap(timingProfile: string) {
    const config = loadHubConfig({ TIMING_PROFILE: timingProfile });
    const w = world();
    const preimage = newPreimage();
    const userFiberInvoice = w.userFiber.createInvoiceWithOptions(preimage, { finalExpiryDeltaMs: FIBER_MIN_FINAL_EXPIRY_DELTA_MS });
    const parsed = await w.hubFiber.parseInvoice(userFiberInvoice);
    if (parsed.finalExpiryDeltaMs === null) throw new Error("the user's Fiber invoice should carry a final expiry delta");
    const plan = expectPlan(planLnToFiber(config.timing, { payoutFinalExpiryDeltaMs: parsed.finalExpiryDeltaMs }));

    const { paymentRequest } = await w.hubLn.createHoldInvoice({
      paymentHash: parsed.paymentHash,
      amountSats: SWAP_SATS,
      expirySeconds: config.pricing.quoteTtlSeconds,
      cltvExpiry: plan.holdCltvExpiry,
      memo: "swap",
    });
    // The payer caps the route's total CLTV the way LDK wallets do.
    await w.userLn.payInvoice({ paymentRequest, maxFeeSats: MAX_FEE_SATS, cltvLimit: config.timing.payerMaxCltv, timeoutSeconds: PAY_TIMEOUT_SECONDS });
    const accepted = await w.hubLn.lookupInvoice(parsed.paymentHash);
    expect(accepted?.state).toBe("ACCEPTED");
    const earliest = Math.min(...(accepted?.htlcExpiryHeights ?? []));

    return { ...w, config, plan, preimage, hash: parsed.paymentHash, userFiberInvoice, earliest };
  }

  it.each(["regtest", "mutinynet", "testnet", "mainnet"])(
    "%s: the plan is payable, the Fiber payout fits, and the hub settles before LND's deadline",
    async (timingProfile) => {
      const s = await acceptedSwap(timingProfile);
      const p = s.config.timing;

      const payout = expectPlan(
        checkLnToFiberPayout(p, {
          earliestHtlcExpiryHeight: s.earliest,
          currentHeight: (await s.hubLn.getInfo()).blockHeight,
          plannedTlcExpiryLimitMs: s.plan.payoutTlcExpiryLimitMs,
        }),
      );
      const fiberPayment = await s.hubFiber.payInvoice({
        invoice: s.userFiberInvoice,
        maxFeeAmount: 0n,
        tlcExpiryLimitMs: payout.payoutTlcExpiryLimitMs,
      });
      expect(fiberPayment.state).toBe("Success");
      expect(fiberPayment.preimage).toBe(s.preimage);

      // Worst case: the payee claims at the very end of the Fiber lock while blocks come at the fast interval.
      s.ln.mineBlocks(Math.ceil(payout.payoutTlcExpiryLimitMs / fastBlockMs(p)));
      expect(s.ln.blockHeight).toBeLessThanOrEqual(lnSettleDeadlineHeight(p, s.earliest) - p.lnMarginBlocks + 1);
      expect((await s.hubLn.lookupInvoice(s.hash))?.state).toBe("ACCEPTED");

      await s.hubLn.settleInvoice(s.preimage);
      expect((await s.hubLn.lookupInvoice(s.hash))?.state).toBe("SETTLED");
    },
  );

  it.each(["regtest", "mutinynet", "mainnet"])(
    "%s: whenever the payout check passes after blocks were mined, the worst-case payout still settles in time",
    async (timingProfile) => {
      const outcomes = { paid: 0, refunded: 0 };
      for (let mined = 0; mined <= 40; mined += 1) {
        const s = await acceptedSwap(timingProfile);
        const p = s.config.timing;
        s.ln.mineBlocks(mined);

        const check = checkLnToFiberPayout(p, {
          earliestHtlcExpiryHeight: s.earliest,
          currentHeight: s.ln.blockHeight,
          plannedTlcExpiryLimitMs: s.plan.payoutTlcExpiryLimitMs,
        });
        if (!check.ok) {
          // The hub refunds instead of paying out; the incoming leg is still there to cancel.
          expect((await s.hubLn.lookupInvoice(s.hash))?.state).toBe("ACCEPTED");
          await s.hubLn.cancelInvoice(s.hash);
          expect((await s.userLn.getPayment(s.hash))?.state).toBe("FAILED");
          outcomes.refunded += 1;
          continue;
        }

        s.ln.mineBlocks(Math.ceil(check.payoutTlcExpiryLimitMs / fastBlockMs(p)));
        expect((await s.hubLn.lookupInvoice(s.hash))?.state).toBe("ACCEPTED");
        await s.hubLn.settleInvoice(s.preimage);
        outcomes.paid += 1;
      }

      expect(outcomes.paid).toBeGreaterThan(0);
      expect(outcomes.refunded).toBeGreaterThan(0);
    },
  );

  it("the first refused height comes well before LND would auto-cancel, so the refund is the hub's own", async () => {
    const s = await acceptedSwap("mutinynet");
    const p = s.config.timing;
    let height = s.ln.blockHeight;
    while (
      checkLnToFiberPayout(p, { earliestHtlcExpiryHeight: s.earliest, currentHeight: height, plannedTlcExpiryLimitMs: s.plan.payoutTlcExpiryLimitMs }).ok
    ) {
      height += 1;
    }

    s.ln.mineBlocks(height - s.ln.blockHeight);
    expect(height).toBeLessThan(lnSettleDeadlineHeight(p, s.earliest) - p.lnMarginBlocks);
    expect((await s.hubLn.lookupInvoice(s.hash))?.state).toBe("ACCEPTED");
  });
});

describe("timing scenarios: fiber_to_ln (user pays Fiber, hub pays Lightning)", () => {
  async function heldSwap(timingProfile: string, payoutCltvExpiry: number, holdOverrideMs?: number) {
    const config = loadHubConfig({ TIMING_PROFILE: timingProfile });
    const w = world();
    const preimage = newPreimage();
    const hash = sha256Hex(preimage);
    const userLnInvoice = w.userLn.createInvoiceWithPreimage(preimage, SWAP_SATS, { cltvExpiry: payoutCltvExpiry });
    const decoded = await w.hubLn.decodeInvoice(userLnInvoice);
    const plan = expectPlan(
      planFiberToLn(config.timing, {
        payoutCltvExpiry: decoded.cltvExpiry,
        configuredHoldFinalExpiryDeltaMs: config.swaps.fiberHoldFinalExpiryDeltaMs,
      }),
    );
    const holdFinalExpiryDeltaMs = holdOverrideMs ?? plan.holdFinalExpiryDeltaMs;

    const { invoice } = await w.hubFiber.createHoldInvoice({
      paymentHash: hash,
      amount: SWAP_SHANNONS,
      udtTypeScript: null,
      expirySeconds: config.pricing.quoteTtlSeconds,
      finalExpiryDeltaMs: holdFinalExpiryDeltaMs,
      description: "swap",
    });
    // Worst case for the hub: the payer's TLC expires as early as Fiber allows, with no extra hop delta.
    await w.userFiber.payInvoice({ invoice, maxFeeAmount: 0n, tlcExpiryLimitMs: holdFinalExpiryDeltaMs });
    const [held] = await w.hubFiber.heldTlcs(hash, null);
    if (!held) throw new Error("the hold invoice should hold the user's TLC");

    return { ...w, config, plan, preimage, hash, userLnInvoice, decoded, heldTlcExpiresAt: held.expiresAt };
  }

  it.each([
    ["regtest", 40],
    ["regtest", 80],
    ["mutinynet", 80],
    ["mutinynet", 144],
    ["testnet", 80],
    ["mainnet", 144],
  ] as const)("%s, payout CLTV %d: the Lightning payout resolves before fnn early-fails the held TLC", async (timingProfile, cltv) => {
    const s = await heldSwap(timingProfile, cltv);
    const p = s.config.timing;

    const { cltvLimit } = expectPlan(
      lnPayoutCltvLimit(p, { heldTlcFailsAt: failsAtOnDefaultChannel(s.heldTlcExpiresAt), now: s.clock.now(), payoutCltvExpiry: s.decoded.cltvExpiry }),
    );
    const lnPayment = await s.hubLn.payInvoice({ paymentRequest: s.userLnInvoice, maxFeeSats: MAX_FEE_SATS, cltvLimit, timeoutSeconds: PAY_TIMEOUT_SECONDS });
    expect(lnPayment.state).toBe("SUCCEEDED");

    // Worst case: the Lightning HTLC stays locked for its whole cltv_limit at the slow interval.
    s.clock.advance(cltvLimit * slowBlockMs(p));
    s.fiber.tick();
    expect(await s.hubFiber.heldTlcs(s.hash, null)).toHaveLength(1);

    await s.hubFiber.settleInvoice(s.hash, lnPayment.preimage ?? "");
    expect((await s.hubFiber.getInvoice(s.hash))?.state).toBe("Paid");
  });

  it("regtest: keeping the configured 6 h hold for a CLTV-40 invoice would leave no room, which is why the plan raises it", async () => {
    const configuredHoldMs = loadHubConfig({}).swaps.fiberHoldFinalExpiryDeltaMs;
    const s = await heldSwap("regtest", 40, configuredHoldMs);

    // (40 + 3 + 1 + 80 route budget) x 15 min + 171 min = 2031 min.
    expect(s.plan.holdFinalExpiryDeltaMs).toBe(minutes(2031));
    expect(s.plan.holdFinalExpiryDeltaMs).toBeGreaterThan(configuredHoldMs);
    expectRefusal(lnPayoutCltvLimit(s.config.timing, { heldTlcFailsAt: failsAtOnDefaultChannel(s.heldTlcExpiresAt), now: s.clock.now(), payoutCltvExpiry: 40 }));

    // The hub refunds: the held TLC is still there to cancel.
    await s.hubFiber.cancelInvoice(s.hash);
    expect((await s.userFiber.getPayment(s.hash))?.state).toBe("Failed");
  });

  it("mutinynet: the payout is refused while the held TLC can still be cancelled, never after fnn has failed it", async () => {
    const s = await heldSwap("mutinynet", 80);
    const p = s.config.timing;
    const STEP_MS = minutes(1);

    while (lnPayoutCltvLimit(p, { heldTlcFailsAt: failsAtOnDefaultChannel(s.heldTlcExpiresAt), now: s.clock.now(), payoutCltvExpiry: 80 }).ok) {
      s.clock.advance(STEP_MS);
    }
    s.fiber.tick();

    expect(await s.hubFiber.heldTlcs(s.hash, null)).toHaveLength(1);
    await s.hubFiber.cancelInvoice(s.hash);
    expect((await s.userFiber.getPayment(s.hash))?.state).toBe("Failed");
  });
});
