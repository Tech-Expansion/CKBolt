import { HttpStatus } from "@nestjs/common";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { SWAP_EVENT } from "../../../src/common/constants/swap.constants";
import { NotFoundError } from "../../../src/common/errors/hub.error";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import type { Direction } from "../../../src/domain/types";
import {
  callCount,
  deferred,
  eventTypes,
  expectPlainSentence,
  flushAsync,
  makeSwapHarness,
  minutes,
  payHoldInvoice,
  processPasses,
  processToRest,
  requireSwap,
  silenceLogs,
  startSwap,
  type LogSpies,
  type SwapHarness,
} from "./swaps.fixtures";

/**
 * Cross-cutting rules of the engine (docs/phase-3-plan.md section 3 and the module spec): one processing at a time per
 * swap, restart safety at every step, errors in one swap never stop the others, every open swap is processed, and what
 * users read never carries node details.
 */

const DIRECTIONS: Direction[] = ["ln_to_fiber", "fiber_to_ln"];

/** The hub node that pays out, and the one that holds the incoming leg, for a direction. */
const payingNode = (h: SwapHarness, direction: Direction) => (direction === "ln_to_fiber" ? h.hubFiber : h.hubLn);
const incomingNode = (h: SwapHarness, direction: Direction) => (direction === "ln_to_fiber" ? h.hubLn : h.hubFiber);

/** Final state of both legs: the user's payout invoice and the hub's hold invoice. */
async function legStates(h: SwapHarness, direction: Direction, hash: string): Promise<{ payout: string | undefined; hold: string | undefined }> {
  if (direction === "ln_to_fiber") {
    return { payout: h.fiberNet.invoices.get(hash)?.state, hold: (await h.hubLn.lookupInvoice(hash))?.state };
  }
  return { payout: h.lnNet.invoices.get(hash)?.state, hold: (await h.hubFiber.getInvoice(hash))?.state };
}

const SETTLED_LEGS: Record<Direction, { payout: string; hold: string }> = {
  ln_to_fiber: { payout: "Paid", hold: "SETTLED" },
  fiber_to_ln: { payout: "SETTLED", hold: "Paid" },
};

describe.each(DIRECTIONS)("swap engine safety (%s)", (direction) => {
  let h: SwapHarness;
  let logs: LogSpies;

  beforeEach(() => {
    logs = silenceLogs();
    h = makeSwapHarness();
  });

  afterEach(() => jest.restoreAllMocks());

  describe("one processing at a time per swap", () => {
    it("three concurrent processSwap calls send the payout only once", async () => {
      const { swap } = await startSwap(h, direction);
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 1);
      expect(requireSwap(h, swap.id).state).toBe("incoming_accepted");

      const node = payingNode(h, direction);
      const gate = deferred();
      const target = node as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const original = target.payInvoice!.bind(node);
      let active = 0;
      let maxActive = 0;
      jest.spyOn(target, "payInvoice").mockImplementation(async (...args: unknown[]) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate.promise;
        active -= 1;
        return original(...args);
      });

      const runs = [h.engine.processSwap(swap.id), h.engine.processSwap(swap.id), h.engine.processSwap(swap.id)];
      await flushAsync();
      gate.resolve();
      await Promise.all(runs);

      expect(callCount(node, "payInvoice")).toBe(1);
      expect(maxActive).toBe(1);
      expect(eventTypes(h, swap.id).filter((t) => t === SWAP_EVENT.PAYOUT_STARTED)).toHaveLength(1);
    });

    it("a processOpenSwaps pass and a processSwap call for the same swap never run its steps side by side", async () => {
      const { swap } = await startSwap(h, direction);
      await payHoldInvoice(h, swap);
      const incoming = incomingNode(h, direction);
      const readMethod = direction === "ln_to_fiber" ? "lookupInvoice" : "getInvoice";
      const target = incoming as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const original = target[readMethod]!.bind(incoming);
      let active = 0;
      let maxActive = 0;
      jest.spyOn(target, readMethod).mockImplementation(async (...args: unknown[]) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await flushAsync(1);
        active -= 1;
        return original(...args);
      });

      await Promise.all([h.engine.processOpenSwaps(), h.engine.processSwap(swap.id), h.engine.processOpenSwaps(), h.engine.processSwap(swap.id)]);

      expect(maxActive).toBe(1);
      expect(callCount(payingNode(h, direction), "payInvoice")).toBeLessThanOrEqual(1);
      const after = requireSwap(h, swap.id);
      expect(after.state).not.toBe("failed");
    });

    it("a call that arrives while a step runs is not lost: the swap is processed again with fresh state", async () => {
      const { swap } = await startSwap(h, direction);
      await payHoldInvoice(h, swap);
      const first = h.engine.processSwap(swap.id);
      await flushAsync(1);
      const second = h.engine.processSwap(swap.id);
      await Promise.all([first, second]);

      expect(requireSwap(h, swap.id).state).not.toBe("pending");
    });
  });

  describe("restart safety", () => {
    it.each([0, 1, 2, 3, 4])("a restart after %i passes resumes from the saved state and completes exactly once", async (passesBeforeCrash) => {
      const { swap, preimage } = await startSwap(h, direction);
      const hash = sha256Hex(preimage);
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, passesBeforeCrash);

      h.restart();
      for (let pass = 0; pass < 6; pass += 1) await h.engine.processOpenSwaps();

      expect(requireSwap(h, swap.id)).toMatchObject({ state: "succeeded", preimage, refunded: false });
      expect(await legStates(h, direction, hash)).toEqual(SETTLED_LEGS[direction]);
      expect(eventTypes(h, swap.id).filter((t) => t === SWAP_EVENT.PAYOUT_STARTED)).toHaveLength(1);
      expect(callCount(incomingNode(h, direction), "cancelInvoice")).toBe(0);
    });

    it("a crash between saving outgoing_in_flight and sending the payout is repaired after the restart", async () => {
      const { swap, preimage } = await startSwap(h, direction);
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 1);
      payingNode(h, direction).failNext = "payInvoice";
      await processPasses(h, swap.id, 1);
      expect(requireSwap(h, swap.id).state).toBe("outgoing_in_flight");

      h.restart();
      for (let pass = 0; pass < 5; pass += 1) await h.engine.processOpenSwaps();
      expect(requireSwap(h, swap.id)).toMatchObject({ state: "succeeded", preimage });
      expect(await legStates(h, direction, sha256Hex(preimage))).toEqual(SETTLED_LEGS[direction]);
    });

    it("a restart while the payout hangs keeps waiting without cancelling, then settles when it succeeds", async () => {
      const { swap, preimage } = await startSwap(h, direction);
      const hash = sha256Hex(preimage);
      const net = direction === "ln_to_fiber" ? h.fiberNet : h.lnNet;
      net.setPayoutBehavior(hash, "hang");
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 2);

      h.restart();
      h.clock.advance(minutes(30));
      for (let pass = 0; pass < 3; pass += 1) await h.engine.processOpenSwaps();
      expect(requireSwap(h, swap.id).state).toBe("outgoing_in_flight");
      expect(callCount(incomingNode(h, direction), "cancelInvoice")).toBe(0);

      net.resolveHanging(hash, "succeed");
      for (let pass = 0; pass < 3; pass += 1) await h.engine.processOpenSwaps();
      expect(requireSwap(h, swap.id).state).toBe("succeeded");
    });

    it("a restart after the preimage was saved settles with the saved preimage", async () => {
      const { swap, preimage } = await startSwap(h, direction);
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 3);
      expect(requireSwap(h, swap.id)).toMatchObject({ state: "outgoing_succeeded", preimage });

      h.restart();
      await h.engine.processOpenSwaps();
      expect(requireSwap(h, swap.id).state).toBe("succeeded");
    });
  });

  describe("errors", () => {
    it("an error in one swap does not stop the others", async () => {
      const broken = await startSwap(h, direction);
      const healthy = await startSwap(h, direction);
      await payHoldInvoice(h, broken.swap);
      await payHoldInvoice(h, healthy.swap);
      const node = incomingNode(h, direction);
      const readMethod = direction === "ln_to_fiber" ? "lookupInvoice" : "getInvoice";
      const target = node as unknown as Record<string, (hash: string) => Promise<unknown>>;
      const original = target[readMethod]!.bind(node);
      jest.spyOn(target, readMethod).mockImplementation(async (hash: string) => {
        if (hash === broken.swap.paymentHash) throw new Error("socket hang up at 10.0.0.7:10009");
        return original(hash);
      });

      await expect(h.engine.processOpenSwaps()).resolves.toBeUndefined();
      expect(requireSwap(h, healthy.swap.id).state).toBe("incoming_accepted");
      expect(requireSwap(h, broken.swap.id).state).toBe("pending");
      for (let pass = 0; pass < 3; pass += 1) await h.engine.processOpenSwaps();
      expect(requireSwap(h, healthy.swap.id).state).toBe("succeeded");
    });

    it("records a step error as an event without node details; the details go to the logs", async () => {
      const { swap } = await startSwap(h, direction);
      await payHoldInvoice(h, swap);
      const node = incomingNode(h, direction);
      node.failNext = direction === "ln_to_fiber" ? "lookupInvoice" : "getInvoice";

      await expect(h.engine.processSwap(swap.id)).resolves.toBeUndefined();
      const errors = h.store.listEvents(swap.id).filter((e) => e.type === SWAP_EVENT.ERROR);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      for (const event of errors) {
        expectPlainSentence(event.detail);
        expect(event.detail).not.toContain("simulated transport error");
      }
      const logged = [...logs.warn.mock.calls, ...logs.error.mock.calls].map((args) => String(args[0]));
      expect(logged.some((line) => line.includes("simulated transport error"))).toBe(true);

      expect(requireSwap(h, swap.id).state).toBe("pending");
      expect((await processPasses(h, swap.id, 1)).state).toBe("incoming_accepted");
    });

    it("a node outage during the payout step neither fails nor refunds the swap", async () => {
      const { swap } = await startSwap(h, direction);
      await payHoldInvoice(h, swap);
      await processPasses(h, swap.id, 2);
      const payer = payingNode(h, direction);
      jest.spyOn(payer, "getPayment").mockRejectedValue(new Error("ECONNREFUSED"));

      const after = await processPasses(h, swap.id, 4);
      expect(after.state).toBe("outgoing_in_flight");
      expect(callCount(incomingNode(h, direction), "cancelInvoice")).toBe(0);
    });
  });

  describe("processOpenSwaps", () => {
    it("processes every open swap, a failed swap still owing a refund included, and leaves final swaps alone", async () => {
      const paid = await startSwap(h, direction);
      await payHoldInvoice(h, paid.swap);
      const unpaid = await startSwap(h, direction);
      const done = await startSwap(h, direction);
      await payHoldInvoice(h, done.swap);
      await processToRest(h, done.swap.id);
      expect(requireSwap(h, done.swap.id).state).toBe("succeeded");

      const owing = await startSwap(h, direction);
      h.store.transition(owing.swap.id, "pending", { state: "failed", failureReason: "test", refunded: false });
      const doneEvents = eventTypes(h, done.swap.id);

      await h.engine.processOpenSwaps();

      expect(requireSwap(h, paid.swap.id).state).toBe("incoming_accepted");
      expect(requireSwap(h, unpaid.swap.id).state).toBe("pending");
      expect(requireSwap(h, owing.swap.id)).toMatchObject({ state: "failed", refunded: true });
      expect(requireSwap(h, done.swap.id).state).toBe("succeeded");
      expect(eventTypes(h, done.swap.id)).toEqual(doneEvents);
    });

    it("resolves with nothing to do", async () => {
      await expect(h.engine.processOpenSwaps()).resolves.toBeUndefined();
    });
  });

  describe("processSwap", () => {
    it("rejects an unknown swap id with 404 not_found", async () => {
      const error = await h.engine.processSwap("00000000-0000-4000-8000-000000000000").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error).toMatchObject({ status: HttpStatus.NOT_FOUND, code: API_ERROR_CODE.NOT_FOUND });
    });

    it("does nothing at all on a failed swap that is already refunded", async () => {
      const { swap, quote } = await startSwap(h, direction);
      h.clock.set(quote.expiresAt + minutes(1));
      await processToRest(h, swap.id);
      expect(requireSwap(h, swap.id)).toMatchObject({ state: "failed", refunded: true });
      const calls = [h.hubLn.calls.length, h.hubFiber.calls.length];
      const events = eventTypes(h, swap.id);

      await processPasses(h, swap.id, 3);
      expect([h.hubLn.calls.length, h.hubFiber.calls.length]).toEqual(calls);
      expect(eventTypes(h, swap.id)).toEqual(events);
    });

    it("getSwap returns null for an unknown id and listEvents an empty list", () => {
      expect(h.engine.getSwap("missing")).toBeNull();
      expect(h.engine.listEvents("missing")).toEqual([]);
    });
  });
});
