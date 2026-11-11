import { SWAP_DIRECTION, SWAP_EVENT, SWAP_STATE } from "../../src/common/constants/swap.constants";
import { SWAP_REASON } from "../../src/domain/swap";
import type { Direction, FiberAssetId } from "../../src/domain/types";
import { getEvents, postDemoPayment } from "../support/hub-http";
import { swapSides, userBalances } from "./support/devnet-nodes";
import {
  createDemoSwap,
  expectBalancesMoved,
  expectRefundedOnNodes,
  NO_BALANCE_CHANGE,
  requireAsset,
  useE2eContext,
  waitForFinishedSwap,
} from "./support/e2e-flow";

/**
 * Scenario 5: the payout becomes impossible after the swap was created: the user cancels the payout invoice its node
 * made (the demo wallet's invoice on fnn-user or lnd-user). The user then pays the hold invoice; the hub accepts it,
 * its payout fails for good, and it cancels the hold invoice: the swap fails as refunded, the user's payment fails, and
 * no funds move.
 */

const CASES: ReadonlyArray<[Direction, FiberAssetId, number]> = [
  [SWAP_DIRECTION.LN_TO_FIBER, "CKB", 2_201],
  [SWAP_DIRECTION.FIBER_TO_LN, "CKB", 2_202],
];

describe("refund when the payout fails", () => {
  const e2e = useE2eContext();

  it.each(CASES)("%s %s (%s sats): the hold invoice is cancelled and the user's payment comes back", async (direction, assetId, sats) => {
    const hub = await e2e.startHub();
    const sides = swapSides(e2e.nodes, direction);
    const asset = requireAsset(hub, assetId);
    const before = await userBalances(e2e.nodes, asset);

    const { payout, swap } = await createDemoSwap(hub, direction, assetId, BigInt(sats));
    await sides.cancelPayoutInvoice(payout.paymentHash);
    expect(await sides.payoutInvoiceStatus(swap.paymentHash)).toBe(sides.states.payout.cancelled);

    await postDemoPayment(hub, swap.id);
    const done = await waitForFinishedSwap(hub, swap.id);
    expect(done).toMatchObject({ state: SWAP_STATE.FAILED, refunded: true, preimage: null, failureReason: SWAP_REASON.payoutFailed });
    const events = (await getEvents(hub, swap.id)).map((event) => event.type);
    expect(events).toEqual(expect.arrayContaining([SWAP_EVENT.INCOMING_ACCEPTED, SWAP_EVENT.PAYOUT_STARTED, SWAP_EVENT.PAYOUT_FAILED, SWAP_EVENT.CANCELLED]));
    expect(events).not.toContain(SWAP_EVENT.SETTLED);

    await expectRefundedOnNodes(sides, swap.paymentHash, { paid: true });
    expect(await sides.payoutInvoiceStatus(swap.paymentHash)).toBe(sides.states.payout.cancelled);
    await expectBalancesMoved(e2e.nodes, asset, before, NO_BALANCE_CHANGE);
  });
});
