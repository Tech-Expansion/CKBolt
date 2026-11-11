import { createHash } from "node:crypto";
import { SWAP_EVENT, SWAP_STATE } from "../../../src/common/constants/swap.constants";
import { SWAP_REASON } from "../../../src/domain/swap";
import type { Direction, FiberAssetId, Hex32 } from "../../../src/domain/types";
import type { SwapDto } from "../../../src/interfaces/http/contract/responses";
import {
  API_PATH,
  createSwap,
  getEvents,
  getSwap,
  isFinished,
  lightningQuote,
  postDemoInvoice,
  postDemoPayment,
  postQuote,
  processUntil,
  startFakeHub,
  startPaidDemoSwap,
  useHubLifecycle,
  waitForSwap,
  type FakeHub,
} from "./integration.fixtures";

/**
 * Whole swaps over HTTP on the real composition root: POST /v1/quotes -> POST /v1/demo/invoices -> POST /v1/swaps ->
 * POST /v1/demo/payments -> the engine -> GET /v1/swaps/:id and its events. Both directions, CKB and RUSD, the
 * success path and the refund path (docs/phase-3-plan.md section 3).
 */

const sha256 = (hex: Hex32): Hex32 => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

const SUCCESS_EVENTS = [
  SWAP_EVENT.CREATED,
  SWAP_EVENT.INCOMING_ACCEPTED,
  SWAP_EVENT.PAYOUT_STARTED,
  SWAP_EVENT.PAYOUT_SUCCEEDED,
  SWAP_EVENT.SETTLED,
];
const REFUND_EVENTS = [
  SWAP_EVENT.CREATED,
  SWAP_EVENT.INCOMING_ACCEPTED,
  SWAP_EVENT.PAYOUT_STARTED,
  SWAP_EVENT.PAYOUT_FAILED,
  SWAP_EVENT.CANCELLED,
];

const CASES: ReadonlyArray<[Direction, FiberAssetId]> = [
  ["ln_to_fiber", "CKB"],
  ["ln_to_fiber", "RUSD"],
  ["fiber_to_ln", "CKB"],
  ["fiber_to_ln", "RUSD"],
];

/** Where each leg lives as the user sees it: ln_to_fiber pays on Lightning and receives on Fiber. */
const legNetworks = (direction: Direction) =>
  direction === "ln_to_fiber" ? { pay: "lightning", receive: "fiber" } : { pay: "fiber", receive: "lightning" };

/** Hold invoice state on the hub's incoming node, and the user's payment of it, read straight from the fake nodes. */
async function incomingLeg(hub: FakeHub, direction: Direction, hash: Hex32) {
  if (direction === "ln_to_fiber") {
    return { invoice: (await hub.hubLn.lookupInvoice(hash))?.state, payment: (await hub.userLn.getPayment(hash))?.state };
  }
  return { invoice: (await hub.hubFiber.getInvoice(hash))?.state, payment: (await hub.userFiber.getPayment(hash))?.state };
}

/** Makes the hub's payout to the user's invoice end as `behavior` on the paying network. */
function setPayout(hub: FakeHub, direction: Direction, hash: Hex32, behavior: "fail" | "hang"): void {
  if (direction === "ln_to_fiber") hub.fiber.setPayoutBehavior(hash, behavior);
  else hub.ln.setPayoutBehavior(hash, behavior);
}

function resolvePayout(hub: FakeHub, direction: Direction, hash: Hex32, outcome: "succeed" | "fail"): void {
  if (direction === "ln_to_fiber") hub.fiber.resolveHanging(hash, outcome);
  else hub.ln.resolveHanging(hash, outcome);
}

const SETTLED_INCOMING = { ln_to_fiber: { invoice: "SETTLED", payment: "SUCCEEDED" }, fiber_to_ln: { invoice: "Paid", payment: "Success" } };
const REFUNDED_INCOMING = { ln_to_fiber: { invoice: "CANCELED", payment: "FAILED" }, fiber_to_ln: { invoice: "Cancelled", payment: "Failed" } };
const HELD_INCOMING = { ln_to_fiber: { invoice: "ACCEPTED", payment: "IN_FLIGHT" }, fiber_to_ln: { invoice: "Received", payment: "Inflight" } };

describe("Swaps over HTTP on the real AppModule", () => {
  const lifecycle = useHubLifecycle();
  const start = async (options?: Parameters<typeof startFakeHub>[0]): Promise<FakeHub> => lifecycle.track(await startFakeHub(options));

  describe.each(CASES)("%s %s", (direction, asset) => {
    it("quote -> demo invoice -> swap (201 + Location) -> demo payment (202) -> succeeded with the preimage", async () => {
      const hub = await start();
      const http = hub.http;

      const quote = await postQuote(hub, lightningQuote(direction, asset));
      expect(quote).toMatchObject({ direction, asset, pay: { network: legNetworks(direction).pay }, receive: { network: legNetworks(direction).receive } });
      expect((await http().get(API_PATH.quote(quote.id)).expect(200)).body).toEqual(quote);

      const payout = await postDemoInvoice(hub, quote);
      const created = await createSwap(hub, quote.id, payout.invoice, true);
      expect(created).toMatchObject({
        quoteId: quote.id,
        direction,
        asset,
        state: SWAP_STATE.PENDING,
        paymentHash: payout.paymentHash,
        pay: { ...quote.pay, invoice: expect.any(String) },
        receive: { ...quote.receive, invoice: payout.invoice },
        refunded: false,
        failureReason: null,
        preimage: null,
        demo: true,
        quoteExpiresAt: quote.expiresAt,
        links: { self: API_PATH.swap(created.id), events: API_PATH.swapEvents(created.id) },
      });
      expect(created.pay.invoice).not.toBe(payout.invoice);
      // The cancel token is in the 201 only: GET shows the same swap without it.
      const { cancelToken, ...swap } = created;
      expect(cancelToken).toMatch(/^[0-9a-f]{64}$/);
      const read = (await http().get(API_PATH.swap(created.id)).expect(200)).body as SwapDto;
      expect(read).toEqual(swap);
      expect(JSON.stringify(read)).not.toContain(cancelToken);

      await postDemoPayment(hub, created.id);
      const done = await processUntil(hub, created.id);

      expect(done).toMatchObject({ state: SWAP_STATE.SUCCEEDED, refunded: false, failureReason: null, paymentHash: payout.paymentHash });
      expect(done.preimage).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256(done.preimage as string)).toBe(payout.paymentHash);
      expect(await incomingLeg(hub, direction, payout.paymentHash)).toEqual(SETTLED_INCOMING[direction]);

      const events = await getEvents(hub, created.id);
      expect(events.map((event) => event.type)).toEqual(SUCCESS_EVENTS);
      for (const event of events) {
        expect(event.at).toMatch(ISO_8601);
        expect(event.detail.length).toBeGreaterThan(0);
      }
    });

    it("refunds when the payout fails: failed, refunded, the user's held payment is returned", async () => {
      const hub = await start();
      const { swap } = await startPaidDemoSwap(hub, direction, asset, (payout) => setPayout(hub, direction, payout.paymentHash, "fail"));

      const done = await processUntil(hub, swap.id);

      expect(done).toMatchObject({ state: SWAP_STATE.FAILED, refunded: true, failureReason: SWAP_REASON.payoutFailed, preimage: null });
      expect(await incomingLeg(hub, direction, swap.paymentHash)).toEqual(REFUNDED_INCOMING[direction]);
      expect((await getEvents(hub, swap.id)).map((event) => event.type)).toEqual(REFUND_EVENTS);
    });
  });

  describe.each(["ln_to_fiber", "fiber_to_ln"] as const)("%s safety", (direction) => {
    it("never cancels the incoming leg while the payout is in flight; refunds once it definitely fails", async () => {
      const hub = await start();
      const { swap } = await startPaidDemoSwap(hub, direction, "CKB", (payout) => setPayout(hub, direction, payout.paymentHash, "hang"));

      const inFlight = await processUntil(hub, swap.id, (s) => s.state === SWAP_STATE.OUTGOING_IN_FLIGHT);
      for (let pass = 0; pass < 5; pass += 1) await hub.engine.processOpenSwaps();

      expect(await getSwap(hub, swap.id)).toMatchObject({ state: SWAP_STATE.OUTGOING_IN_FLIGHT, refunded: false });
      expect(inFlight.state).toBe(SWAP_STATE.OUTGOING_IN_FLIGHT);
      expect(await incomingLeg(hub, direction, swap.paymentHash)).toEqual(HELD_INCOMING[direction]);
      const incomingNode = direction === "ln_to_fiber" ? hub.hubLn : hub.hubFiber;
      expect(incomingNode.calls).not.toContain("cancelInvoice");

      resolvePayout(hub, direction, swap.paymentHash, "fail");
      const done = await processUntil(hub, swap.id);

      expect(done).toMatchObject({ state: SWAP_STATE.FAILED, refunded: true, failureReason: SWAP_REASON.payoutFailed });
      expect(await incomingLeg(hub, direction, swap.paymentHash)).toEqual(REFUNDED_INCOMING[direction]);
    });

    it("a payout that hangs and then succeeds still completes the swap", async () => {
      const hub = await start();
      const { swap } = await startPaidDemoSwap(hub, direction, "CKB", (payout) => setPayout(hub, direction, payout.paymentHash, "hang"));
      await processUntil(hub, swap.id, (s) => s.state === SWAP_STATE.OUTGOING_IN_FLIGHT);

      resolvePayout(hub, direction, swap.paymentHash, "succeed");
      const done = await processUntil(hub, swap.id);

      expect(done.state).toBe(SWAP_STATE.SUCCEEDED);
      expect(await incomingLeg(hub, direction, swap.paymentHash)).toEqual(SETTLED_INCOMING[direction]);
    });

    it("an unpaid swap fails and releases its hold invoice once the quote expires", async () => {
      const hub = await start();
      const quote = await postQuote(hub, lightningQuote(direction, "CKB"));
      const payout = await postDemoInvoice(hub, quote);
      const swap = await createSwap(hub, quote.id, payout.invoice, true);

      await hub.engine.processOpenSwaps();
      expect((await getSwap(hub, swap.id)).state).toBe(SWAP_STATE.PENDING);

      hub.clock.set(Date.parse(quote.expiresAt) + 1);
      const done = await processUntil(hub, swap.id);

      expect(done).toMatchObject({ state: SWAP_STATE.FAILED, refunded: true, failureReason: SWAP_REASON.quoteExpiredUnpaid, preimage: null });
      expect((await getEvents(hub, swap.id)).map((event) => event.type)).toContain(SWAP_EVENT.EXPIRED);
      expect(hub.store.listOpenSwaps()).toEqual([]);
      // The hold invoice can no longer be paid, and the demo wallet refuses to try.
      expect(["CANCELED", "Cancelled", "Expired"]).toContain((await incomingLeg(hub, direction, swap.paymentHash)).invoice);
      const late = await hub.http().post(API_PATH.DEMO_PAYMENTS).send({ swapId: swap.id });
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe("conflict");
    });
  });

  it("the scheduler alone finishes a swap: no engine pass from the test and no node push hints", async () => {
    const hub = await start({ pushHints: false, env: { SWAP_POLL_INTERVAL_MS: "20" } });
    const processOpenSwaps = jest.spyOn(hub.engine, "processOpenSwaps");
    const { swap } = await startPaidDemoSwap(hub, "ln_to_fiber", "RUSD");

    const done: SwapDto = await waitForSwap(hub, swap.id, isFinished, 5_000);

    expect(done.state).toBe(SWAP_STATE.SUCCEEDED);
    expect(processOpenSwaps).toHaveBeenCalled();
    expect(hub.hubLn.calls).toContain("settleInvoice");
  });

  it("node push hints alone finish a swap: no engine pass from the test and no timer", async () => {
    const hub = await start();
    const processOpenSwaps = jest.spyOn(hub.engine, "processOpenSwaps");
    const { swap } = await startPaidDemoSwap(hub, "fiber_to_ln", "CKB");

    const done = await waitForSwap(hub, swap.id, isFinished, 5_000);

    expect(done.state).toBe(SWAP_STATE.SUCCEEDED);
    expect(processOpenSwaps).not.toHaveBeenCalled();
  });

  it("lists the swap's events oldest first as { data: [...] }, the same before and after more passes", async () => {
    const hub = await start();
    const { swap } = await startPaidDemoSwap(hub, "ln_to_fiber", "CKB");
    await processUntil(hub, swap.id);
    const first = await getEvents(hub, swap.id);

    for (let pass = 0; pass < 3; pass += 1) await hub.engine.processOpenSwaps();

    expect(await getEvents(hub, swap.id)).toEqual(first);
    const times = first.map((event) => Date.parse(event.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
