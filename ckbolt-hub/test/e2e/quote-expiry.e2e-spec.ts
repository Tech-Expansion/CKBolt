import { API_ERROR_CODE } from "../../src/common/constants/api.constants";
import { MS_PER_SECOND } from "../../src/common/constants/protocol.constants";
import { SWAP_DIRECTION, SWAP_EVENT, SWAP_STATE } from "../../src/common/constants/swap.constants";
import { SWAP_REASON } from "../../src/domain/swap";
import type { Direction, FiberAssetId } from "../../src/domain/types";
import { expectApiError, getEvents, lightningSideQuote, postDemoInvoice, postQuote, postSwap } from "../support/hub-http";
import { swapSides, userBalances } from "./support/devnet-nodes";
import {
  createDemoSwap,
  expectBalancesMoved,
  expectRefundedOnNodes,
  NO_BALANCE_CHANGE,
  requireAsset,
  sleepUntil,
  useE2eContext,
  waitForFinishedSwap,
} from "./support/e2e-flow";

/**
 * Scenario 6: a hub whose quotes live only a few seconds (QUOTE_TTL_SECONDS). A swap on an expired quote is refused
 * with 422 quote_expired before anything is issued on the nodes; a swap whose quote expires before it is paid ends
 * failed as expired, its hold invoice cancelled or expired, and nothing kept.
 */

/** Long enough to quote, make the payout invoice and create the swap; short enough to wait for. */
const SHORT_QUOTE_TTL_SECONDS = 10;
/** The scheduler passes every second, so the expiry is noticed soon after it happens. */
const FAST_POLL_MS = MS_PER_SECOND;
const SHORT_QUOTES_ENV = { QUOTE_TTL_SECONDS: String(SHORT_QUOTE_TTL_SECONDS), SWAP_POLL_INTERVAL_MS: String(FAST_POLL_MS) };

const CASES: ReadonlyArray<[Direction, FiberAssetId, number]> = [
  [SWAP_DIRECTION.LN_TO_FIBER, "CKB", 2_301],
  [SWAP_DIRECTION.FIBER_TO_LN, "CKB", 2_302],
];

describe("quote expiry", () => {
  const e2e = useE2eContext();

  it.each(CASES)("%s %s (%s sats): a swap on an expired quote is refused with 422 quote_expired", async (direction, assetId, sats) => {
    const hub = await e2e.startHub({ env: SHORT_QUOTES_ENV });
    const sides = swapSides(e2e.nodes, direction);
    const quote = await postQuote(hub, lightningSideQuote(direction, assetId, BigInt(sats)));
    const payout = await postDemoInvoice(hub, quote);

    await sleepUntil(quote.expiresAt);
    expectApiError(await postSwap(hub, quote.id, payout.invoice, true), 422, API_ERROR_CODE.QUOTE_EXPIRED);
    expect(await sides.holdInvoiceStatus(payout.paymentHash)).toBeNull();
    expect(await sides.payoutInvoiceStatus(payout.paymentHash)).toBe(sides.states.payout.open);
  });

  it.each(CASES)("%s %s (%s sats): an unpaid swap fails when its quote expires, keeping nothing", async (direction, assetId, sats) => {
    const hub = await e2e.startHub({ env: SHORT_QUOTES_ENV });
    const sides = swapSides(e2e.nodes, direction);
    const asset = requireAsset(hub, assetId);
    const before = await userBalances(e2e.nodes, asset);

    const { swap } = await createDemoSwap(hub, direction, assetId, BigInt(sats));
    expect(swap.state).toBe(SWAP_STATE.PENDING);
    await sleepUntil(swap.quoteExpiresAt);

    const done = await waitForFinishedSwap(hub, swap.id);
    expect(done).toMatchObject({ state: SWAP_STATE.FAILED, refunded: true, preimage: null, failureReason: SWAP_REASON.quoteExpiredUnpaid });
    const events = (await getEvents(hub, swap.id)).map((event) => event.type);
    // Plus "cancelled" when the hub cancelled the hold invoice before the node expired it on its own.
    expect(events.filter((type) => type !== SWAP_EVENT.CANCELLED)).toEqual([SWAP_EVENT.CREATED, SWAP_EVENT.EXPIRED]);

    await expectRefundedOnNodes(sides, swap.paymentHash, { paid: false });
    expect(await sides.payoutInvoiceStatus(swap.paymentHash)).toBe(sides.states.payout.open);
    await expectBalancesMoved(e2e.nodes, asset, before, NO_BALANCE_CHANGE);
  });
});
