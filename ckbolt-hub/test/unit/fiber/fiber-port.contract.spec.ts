import type { FiberPort } from "../../../src/application/ports/fiber.port";
import {
  FIBER_MAX_TLC_EXPIRY_LIMIT_MS,
  FIBER_MIN_FINAL_EXPIRY_DELTA_MS,
  MS_PER_HOUR,
  MS_PER_MINUTE,
} from "../../../src/common/constants/protocol.constants";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import type { CkbNetwork, Hex32 } from "../../../src/domain/types";
import { FiberRpcAdapter } from "../../../src/infrastructure/fiber/fiber-rpc.adapter";
import { FiberRpcClient } from "../../../src/infrastructure/fiber/fiber-rpc.client";
import { FakeClock, FakeFiberNetwork } from "../../fakes";
import { HOLD_FINAL_EXPIRY_DELTA_MS, ONE_CKB, OTHER_PREIMAGE, PAYMENT_HASH, PREIMAGE, QUOTE_TTL_SECONDS, RUSD_SCRIPT } from "./fiber.fixtures";
import { FnnSimulator } from "./fnn-simulator";

/**
 * The FiberPort contract, run against both implementations the hub uses: FakeFiberNode (what the engine's tests use)
 * and FiberRpcAdapter + FiberRpcClient talking JSON-RPC text to a wire-level fnn stand-in. Same scenarios, same
 * expectations: if they diverge, either the fake or the adapter misrepresents fnn.
 */

interface Harness {
  clock: FakeClock;
  port: FiberPort;
  network: CkbNetwork;
  /** A payer's TLC arrives and fully pays the hold invoice (Received, TLC held). */
  payHold(invoice: string): Promise<void>;
  /** fnn fails the held TLC near its expiry; the invoice keeps saying Received. */
  timeOutHeldTlc(paymentHash: Hex32): void;
  /** A regular sha256 invoice of another node, whose payment stays in flight until completed or failed. */
  merchantInvoice(preimage: Hex32, amount: bigint): Promise<string>;
  completeOutgoing(paymentHash: Hex32, preimage: Hex32): void;
  failOutgoing(paymentHash: Hex32): void;
  /** send_payment calls the node received so far; null when the implementation cannot tell. */
  sendCount(): number | null;
}

function fakeHarness(): Harness {
  const clock = new FakeClock();
  const net = new FakeFiberNetwork("devnet", clock);
  const hub = net.node("hub");
  const payer = net.node("payer");
  const merchant = net.node("merchant");
  return {
    clock,
    port: hub,
    network: "devnet",
    payHold: async (invoice) => {
      const status = await payer.payInvoice({ invoice, maxFeeAmount: 0n, tlcExpiryLimitMs: FIBER_MAX_TLC_EXPIRY_LIMIT_MS });
      if (status.state === "Failed") throw new Error(`payer could not pay: ${status.failedError}`);
    },
    timeOutHeldTlc: () => {
      clock.advance(FIBER_MAX_TLC_EXPIRY_LIMIT_MS);
      net.tick();
    },
    merchantInvoice: async (preimage, amount) => {
      net.setPayoutBehavior(sha256Hex(preimage), "hang");
      return (await merchant.createInvoice({ preimage, amount, udtTypeScript: null, expirySeconds: 3_600, description: "merchant" })).invoice;
    },
    completeOutgoing: (paymentHash) => net.resolveHanging(paymentHash, "succeed"),
    failOutgoing: (paymentHash) => net.resolveHanging(paymentHash, "fail"),
    sendCount: () => null,
  };
}

function adapterHarness(): Harness {
  const clock = new FakeClock();
  const sim = new FnnSimulator("Fibd", clock);
  const client = new FiberRpcClient({ url: "http://fnn.test:8227", timeoutMs: 1_000, httpPost: sim.httpPost });
  return {
    clock,
    port: new FiberRpcAdapter(client, "devnet"),
    network: "devnet",
    payHold: async (invoice) => sim.receiveHoldPayment(sim.hashOf(invoice)),
    timeOutHeldTlc: (paymentHash) => sim.timeOutHeldTlc(paymentHash),
    merchantInvoice: async (preimage, amount) => sim.registerExternalInvoice({ preimage, amount }).address,
    completeOutgoing: (paymentHash, preimage) => sim.setPayment(paymentHash, { status: "Success", preimage }),
    failOutgoing: (paymentHash) => sim.setPayment(paymentHash, { status: "Failed", failedError: "Failed to build route" }),
    sendCount: () => sim.countOf("send_payment"),
  };
}

const IN_FLIGHT_STATES = ["Created", "Inflight"];

describe.each<[string, () => Harness]>([
  ["FakeFiberNode", fakeHarness],
  ["FiberRpcAdapter over fnn JSON-RPC", adapterHarness],
])("FiberPort contract: %s", (_name, makeHarness) => {
  let h: Harness;

  const holdArgs = {
    paymentHash: PAYMENT_HASH,
    amount: 25n * ONE_CKB,
    udtTypeScript: RUSD_SCRIPT,
    expirySeconds: QUOTE_TTL_SECONDS,
    finalExpiryDeltaMs: HOLD_FINAL_EXPIRY_DELTA_MS,
    description: "ckbolt swap",
  };

  const createHold = async (): Promise<string> => (await h.port.createHoldInvoice(holdArgs)).invoice;

  const receivedHold = async (): Promise<void> => {
    await h.payHold(await createHold());
    expect(await h.port.getInvoice(PAYMENT_HASH)).toMatchObject({ state: "Received" });
  };

  beforeEach(() => {
    h = makeHarness();
  });

  describe("node", () => {
    it("reports its id and network", async () => {
      const info = await h.port.getInfo();
      expect(info.network).toBe(h.network);
      expect(info.nodeId).toMatch(/^[0-9a-f]{66}$/);
    });
  });

  describe("hold invoices (fiber_to_ln incoming leg)", () => {
    it("creates a sha256 hold invoice that parses back to what was asked", async () => {
      const parsed = await h.port.parseInvoice(await createHold());
      expect(parsed).toMatchObject({
        paymentHash: PAYMENT_HASH,
        amount: 25n * ONE_CKB,
        network: h.network,
        hashAlgorithm: "sha256",
        udtTypeScript: RUSD_SCRIPT,
        finalExpiryDeltaMs: HOLD_FINAL_EXPIRY_DELTA_MS,
      });
      expect(parsed.expiresAt).toBe(parsed.createdAt + QUOTE_TTL_SECONDS * 1_000);
      expect(parsed.createdAt).toBe(h.clock.now());
      expect(parsed.payee).toEqual(expect.any(String));
    });

    it("is Open until paid, then Received with the TLC held", async () => {
      const invoice = await createHold();
      expect(await h.port.getInvoice(PAYMENT_HASH)).toEqual({ paymentHash: PAYMENT_HASH, state: "Open", amount: 25n * ONE_CKB });
      expect(await h.port.heldTlcs(PAYMENT_HASH, RUSD_SCRIPT)).toEqual([]);

      await h.payHold(invoice);

      expect(await h.port.getInvoice(PAYMENT_HASH)).toMatchObject({ state: "Received" });
      const held = await h.port.heldTlcs(PAYMENT_HASH, RUSD_SCRIPT);
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ paymentHash: PAYMENT_HASH, amount: 25n * ONE_CKB });
      expect(held[0]!.expiresAt).toBeGreaterThan(h.clock.now() + HOLD_FINAL_EXPIRY_DELTA_MS - MS_PER_MINUTE);
    });

    it("settles with the preimage to Paid, and settling again is not an error", async () => {
      await receivedHold();
      await h.port.settleInvoice(PAYMENT_HASH, PREIMAGE);
      expect(await h.port.getInvoice(PAYMENT_HASH)).toMatchObject({ state: "Paid" });
      expect(await h.port.heldTlcs(PAYMENT_HASH, RUSD_SCRIPT)).toEqual([]);
      await expect(h.port.settleInvoice(PAYMENT_HASH, PREIMAGE)).resolves.toBeUndefined();
    });

    it("refuses to cancel once Paid", async () => {
      await receivedHold();
      await h.port.settleInvoice(PAYMENT_HASH, PREIMAGE);
      await expect(h.port.cancelInvoice(PAYMENT_HASH)).rejects.toThrow();
      expect(await h.port.getInvoice(PAYMENT_HASH)).toMatchObject({ state: "Paid" });
    });

    it("refuses a preimage whose sha256 is not the hash, and keeps holding", async () => {
      await receivedHold();
      await expect(h.port.settleInvoice(PAYMENT_HASH, OTHER_PREIMAGE)).rejects.toThrow();
      expect(await h.port.getInvoice(PAYMENT_HASH)).toMatchObject({ state: "Received" });
      expect(await h.port.heldTlcs(PAYMENT_HASH, RUSD_SCRIPT)).toHaveLength(1);
    });

    it("refuses to settle an invoice nobody has paid", async () => {
      await createHold();
      await expect(h.port.settleInvoice(PAYMENT_HASH, PREIMAGE)).rejects.toThrow();
      expect(await h.port.getInvoice(PAYMENT_HASH)).toMatchObject({ state: "Open" });
    });

    it("cancels a Received invoice (refund), releases the TLC, and cancelling again is not an error", async () => {
      await receivedHold();
      await h.port.cancelInvoice(PAYMENT_HASH);
      expect(await h.port.getInvoice(PAYMENT_HASH)).toMatchObject({ state: "Cancelled" });
      expect(await h.port.heldTlcs(PAYMENT_HASH, RUSD_SCRIPT)).toEqual([]);
      await expect(h.port.cancelInvoice(PAYMENT_HASH)).resolves.toBeUndefined();
    });

    it("refuses to settle a cancelled invoice", async () => {
      await receivedHold();
      await h.port.cancelInvoice(PAYMENT_HASH);
      await expect(h.port.settleInvoice(PAYMENT_HASH, PREIMAGE)).rejects.toThrow();
      expect(await h.port.getInvoice(PAYMENT_HASH)).toMatchObject({ state: "Cancelled" });
    });

    it("cancels an Open invoice", async () => {
      await createHold();
      await h.port.cancelInvoice(PAYMENT_HASH);
      expect(await h.port.getInvoice(PAYMENT_HASH)).toMatchObject({ state: "Cancelled" });
    });

    it("reads an unpaid invoice past its expiry as Expired", async () => {
      await createHold();
      h.clock.advance(QUOTE_TTL_SECONDS * 1_000 + 1);
      expect(await h.port.getInvoice(PAYMENT_HASH)).toMatchObject({ state: "Expired" });
    });

    it("still says Received after the held TLC timed out, while heldTlcs shows nothing is held", async () => {
      await receivedHold();
      h.timeOutHeldTlc(PAYMENT_HASH);
      expect(await h.port.getInvoice(PAYMENT_HASH)).toMatchObject({ state: "Received" });
      expect(await h.port.heldTlcs(PAYMENT_HASH, RUSD_SCRIPT)).toEqual([]);
    });

    it("refuses a second invoice on the same payment hash", async () => {
      await createHold();
      await expect(h.port.createHoldInvoice({ ...holdArgs, amount: 1n })).rejects.toThrow();
    });

    it("refuses a final_expiry_delta below fnn's 160-minute minimum", async () => {
      await expect(h.port.createHoldInvoice({ ...holdArgs, finalExpiryDeltaMs: FIBER_MIN_FINAL_EXPIRY_DELTA_MS - 1 })).rejects.toThrow();
    });

    it("counts no held TLC for another asset than the one asked for (CKB, for this RUSD invoice)", async () => {
      await receivedHold();
      expect(await h.port.heldTlcs(PAYMENT_HASH, RUSD_SCRIPT)).toHaveLength(1);
      expect(await h.port.heldTlcs(PAYMENT_HASH, null)).toEqual([]);
    });

    it("knows nothing about an unknown hash", async () => {
      expect(await h.port.getInvoice(PAYMENT_HASH)).toBeNull();
      expect(await h.port.heldTlcs(PAYMENT_HASH, RUSD_SCRIPT)).toEqual([]);
    });
  });

  describe("regular invoices (demo wallet)", () => {
    it("creates a sha256 invoice whose hash is sha256(preimage)", async () => {
      const created = await h.port.createInvoice({ preimage: PREIMAGE, amount: ONE_CKB, udtTypeScript: null, expirySeconds: 600, description: "demo" });
      expect(created.paymentHash).toBe(PAYMENT_HASH);
      const parsed = await h.port.parseInvoice(created.invoice);
      expect(parsed).toMatchObject({ paymentHash: PAYMENT_HASH, hashAlgorithm: "sha256", amount: ONE_CKB, udtTypeScript: null });
      expect(parsed.expiresAt).toBe(parsed.createdAt + 600_000);
    });
  });

  describe("outgoing payments (ln_to_fiber payout)", () => {
    const merchantHash = sha256Hex(OTHER_PREIMAGE);
    /** Above the merchant invoice's 160-minute final expiry delta, as the timing policy guarantees before paying. */
    const payoutLockLimitMs = 8 * MS_PER_HOUR;
    const pay = (invoice: string, tlcExpiryLimitMs = payoutLockLimitMs) =>
      h.port.payInvoice({ invoice, maxFeeAmount: ONE_CKB / 100n, tlcExpiryLimitMs });

    it("knows no payment before paying", async () => {
      expect(await h.port.getPayment(merchantHash)).toBeNull();
    });

    it("fails a payment whose tlc_expiry_limit is below the invoice's final expiry delta", async () => {
      const invoice = await h.merchantInvoice(OTHER_PREIMAGE, 10n * ONE_CKB);
      const status = await pay(invoice, FIBER_MIN_FINAL_EXPIRY_DELTA_MS - MS_PER_MINUTE);
      expect(status).toMatchObject({ paymentHash: merchantHash, state: "Failed", preimage: null });
      expect(status.failedError).toEqual(expect.any(String));
    });

    it("starts a payment, does not start a second one while it is in flight, and returns the preimage on success", async () => {
      const invoice = await h.merchantInvoice(OTHER_PREIMAGE, 10n * ONE_CKB);

      const first = await pay(invoice);
      expect(first.paymentHash).toBe(merchantHash);
      expect(IN_FLIGHT_STATES).toContain(first.state);

      const again = await pay(invoice);
      expect(IN_FLIGHT_STATES).toContain(again.state);
      if (h.sendCount() !== null) expect(h.sendCount()).toBe(1);

      h.completeOutgoing(merchantHash, OTHER_PREIMAGE);
      const done = await h.port.getPayment(merchantHash);
      expect(done).toMatchObject({ state: "Success", preimage: OTHER_PREIMAGE });
      expect(sha256Hex(done!.preimage!)).toBe(merchantHash);

      await expect(pay(invoice)).resolves.toMatchObject({ state: "Success", preimage: OTHER_PREIMAGE });
      if (h.sendCount() !== null) expect(h.sendCount()).toBe(1);
    });

    it("reports a failed payment and pays again when asked after the failure", async () => {
      const invoice = await h.merchantInvoice(OTHER_PREIMAGE, 10n * ONE_CKB);
      await pay(invoice);
      h.failOutgoing(merchantHash);

      const failed = await h.port.getPayment(merchantHash);
      expect(failed).toMatchObject({ state: "Failed", preimage: null });
      expect(failed?.failedError).toEqual(expect.any(String));

      const retry = await pay(invoice);
      expect(IN_FLIGHT_STATES).toContain(retry.state);
      if (h.sendCount() !== null) expect(h.sendCount()).toBe(2);
    });
  });
});
