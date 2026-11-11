import { MS_PER_HOUR } from "../../src/common/constants/protocol.constants";
import { SWAP_DIRECTION, SWAP_STATE } from "../../src/common/constants/swap.constants";
import { preimageMatches } from "../../src/common/utils/hex.util";
import type { Direction, FiberAssetId } from "../../src/domain/types";
import { getSwap, postDemoPayment } from "../support/hub-http";
import { mineBlocks, swapSides, userBalances } from "./support/devnet-nodes";
import {
  balanceChangeOf,
  createDemoSwap,
  eventuallyEquals,
  expectBalancesMoved,
  expectSettledOnNodes,
  requireAsset,
  useE2eContext,
  waitForFinishedSwap,
} from "./support/e2e-flow";

/**
 * Scenario 8: the hub stops after the user paid the hold invoice and before it paid out, and a new hub process on the
 * same database finishes the swap (docs/phase-3-plan.md section 3: "on restart, look up every open hash on both nodes
 * ... and resume"). The first hub gets no push hints and an hour-long poll interval, so after its start-up pass nothing
 * moves the swap: the payment is held, the payout not sent, when it closes. Blocks are mined while no hub runs.
 */

/** The first hub's scheduler would pass again only after this long: never, within the test. */
const IDLE_POLL_ENV = { SWAP_POLL_INTERVAL_MS: String(MS_PER_HOUR) };

/**
 * Regtest blocks mined while the hub is down: the next hub must size the payout from the live hold, not from what was
 * planned. Well inside what the regtest profile's margins absorb before an ln_to_fiber payout no longer fits.
 */
const BLOCKS_WHILE_DOWN = 3;

/** One swap each way in the same asset, so a run leaves the devnet's channels about where they were. */
const CASES: ReadonlyArray<[Direction, FiberAssetId, number]> = [
  [SWAP_DIRECTION.LN_TO_FIBER, "CKB", 2_501],
  [SWAP_DIRECTION.FIBER_TO_LN, "CKB", 2_502],
];

describe("restart recovery", () => {
  const e2e = useE2eContext();

  it.each(CASES)("%s %s (%s sats): a swap paid before a restart is completed by the next hub on the same database", async (direction, assetId, sats) => {
    const sides = swapSides(e2e.nodes, direction);
    const first = await e2e.startHub({ env: IDLE_POLL_ENV, pushHints: false });
    const asset = requireAsset(first, assetId);
    const before = await userBalances(e2e.nodes, asset);

    const { quote, swap } = await createDemoSwap(first, direction, assetId, BigInt(sats));
    const hash = swap.paymentHash;
    await postDemoPayment(first, swap.id);
    expect(await eventuallyEquals(() => sides.holdInvoiceStatus(hash), sides.states.hold.held)).toBe(sides.states.hold.held);
    expect((await getSwap(first, swap.id)).state).toBe(SWAP_STATE.PENDING);
    await first.close();
    expect(await sides.payoutInvoiceStatus(hash)).toBe(sides.states.payout.open);
    await mineBlocks(e2e.nodes, BLOCKS_WHILE_DOWN);

    const second = await e2e.startHub();
    const done = await waitForFinishedSwap(second, swap.id);
    expect(done).toMatchObject({ id: swap.id, state: SWAP_STATE.SUCCEEDED, refunded: false, failureReason: null });
    const preimage = done.preimage ?? "";
    expect(preimageMatches(preimage, hash)).toBe(true);
    await expectSettledOnNodes(sides, hash, preimage);
    await expectBalancesMoved(e2e.nodes, asset, before, balanceChangeOf(quote));
  });
});
