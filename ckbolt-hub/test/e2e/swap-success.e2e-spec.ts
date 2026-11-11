import { SWAP_DIRECTION, SWAP_EVENT, SWAP_STATE } from "../../src/common/constants/swap.constants";
import { preimageMatches } from "../../src/common/utils/hex.util";
import type { Direction, FiberAssetId } from "../../src/domain/types";
import { getEvents, postDemoPayment } from "../support/hub-http";
import { swapSides, userBalances } from "./support/devnet-nodes";
import {
  balanceChangeOf,
  createDemoSwap,
  expectBalancesMoved,
  expectSettledOnNodes,
  requireAsset,
  useE2eContext,
  waitForFinishedSwap,
} from "./support/e2e-flow";

/**
 * Scenarios 1-4: a demo swap in each direction for CKB and the RUSD stand-in, on the devnet's real LND and fnn nodes.
 * quote -> demo payout invoice -> swap -> demo payment -> succeeded; then both nodes of both legs agree: the hub's hold
 * invoice is settled, the user's payout invoice is paid, the user's payment succeeded with the swap's preimage, and the
 * user's channel balances moved by exactly the quoted amounts.
 */

/**
 * Each case swaps its own Lightning amount, so its invoices and payments are easy to find in the node logs. Each asset
 * goes both ways, so a run leaves the devnet's channels about where they were (the hub keeps only its fee).
 */
const CASES: ReadonlyArray<[Direction, FiberAssetId, number]> = [
  [SWAP_DIRECTION.LN_TO_FIBER, "CKB", 2_101],
  [SWAP_DIRECTION.LN_TO_FIBER, "RUSD", 2_102],
  [SWAP_DIRECTION.FIBER_TO_LN, "CKB", 2_103],
  [SWAP_DIRECTION.FIBER_TO_LN, "RUSD", 2_104],
];

/** The events of a swap that went through every state, oldest first. */
const SUCCESS_EVENTS = [SWAP_EVENT.CREATED, SWAP_EVENT.INCOMING_ACCEPTED, SWAP_EVENT.PAYOUT_STARTED, SWAP_EVENT.PAYOUT_SUCCEEDED, SWAP_EVENT.SETTLED];

describe("demo swaps on the devnet", () => {
  const e2e = useE2eContext();

  it.each(CASES)("%s %s (%s sats) settles both legs on one preimage", async (direction, assetId, sats) => {
    const hub = await e2e.startHub();
    const sides = swapSides(e2e.nodes, direction);
    const asset = requireAsset(hub, assetId);
    const before = await userBalances(e2e.nodes, asset);

    const { quote, payout, swap } = await createDemoSwap(hub, direction, assetId, BigInt(sats));
    expect(swap).toMatchObject({ state: SWAP_STATE.PENDING, direction, asset: assetId, paymentHash: payout.paymentHash, demo: true });
    expect(await sides.holdInvoiceStatus(swap.paymentHash)).toBe(sides.states.hold.open);

    await postDemoPayment(hub, swap.id);
    const done = await waitForFinishedSwap(hub, swap.id);
    expect(done).toMatchObject({ state: SWAP_STATE.SUCCEEDED, refunded: false, failureReason: null });
    expect((await getEvents(hub, swap.id)).map((event) => event.type)).toEqual(SUCCESS_EVENTS);

    const preimage = done.preimage ?? "";
    expect(preimageMatches(preimage, swap.paymentHash)).toBe(true);
    await expectSettledOnNodes(sides, swap.paymentHash, preimage);
    await expectBalancesMoved(e2e.nodes, asset, before, balanceChangeOf(quote));
  });
});
