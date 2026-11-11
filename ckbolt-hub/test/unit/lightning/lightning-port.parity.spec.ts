import type { LightningPort } from "../../../src/application/ports/lightning.port";
import type { Hex32 } from "../../../src/domain/types";
import { FakeClock, FakeLightningNetwork } from "../../fakes";
import { START_HEIGHT, newPreimage } from "./lightning.fixtures";
import { LndPackageSimulator, createAdapter } from "./lnd-package.simulator";

/**
 * LightningPort semantics the swap engine relies on, run against the LND adapter (on the package simulator) and against
 * FakeLightningNode, the fake every other module's tests use. If the two disagree here, engine tests on the fake stop
 * saying anything about production.
 */

const CLTV_EXPIRY = 144;
const AMOUNT_SATS = 25_000n;

interface Harness {
  port: LightningPort;
  /** Makes the hold invoice ACCEPTED, as a payer's HTLC arriving at the node would. */
  acceptPayment(paymentHash: Hex32, paymentRequest: string): Promise<void>;
  close(): void;
}

const harnesses: [string, () => Harness][] = [
  [
    "FakeLightningNode",
    () => {
      const net = new FakeLightningNetwork("regtest", new FakeClock(), START_HEIGHT);
      const payer = net.node("payer");
      return {
        port: net.node("hub"),
        acceptPayment: async (_hash, paymentRequest) => {
          await payer.payInvoice({ paymentRequest, maxFeeSats: 10n, cltvLimit: 1_000, timeoutSeconds: 30 });
        },
        close: () => undefined,
      };
    },
  ],
  [
    "LndLightningAdapter",
    () => {
      const sim = new LndPackageSimulator();
      const adapter = createAdapter(sim);
      return {
        port: adapter,
        acceptPayment: async (hash) => sim.acceptHtlcs(hash, [sim.height + CLTV_EXPIRY]),
        close: () => adapter.close(),
      };
    },
  ],
];

describe.each(harnesses)("LightningPort semantics: %s", (_name, createHarness) => {
  let harness: Harness;
  let port: LightningPort;
  let preimage: Hex32;
  let hash: Hex32;

  const createHold = () => port.createHoldInvoice({ paymentHash: hash, amountSats: AMOUNT_SATS, expirySeconds: 180, cltvExpiry: CLTV_EXPIRY, memo: "swap" });

  const accepted = async (): Promise<void> => {
    const { paymentRequest } = await createHold();
    await harness.acceptPayment(hash, paymentRequest);
  };

  beforeEach(() => {
    harness = createHarness();
    port = harness.port;
    ({ preimage, hash } = newPreimage());
  });

  afterEach(() => harness.close());

  it("returns null for an invoice or a payment the node does not know", async () => {
    await expect(port.lookupInvoice(hash)).resolves.toBeNull();
    await expect(port.getPayment(hash)).resolves.toBeNull();
  });

  it("shows a new hold invoice as OPEN with nothing paid", async () => {
    await createHold();
    await expect(port.lookupInvoice(hash)).resolves.toEqual({
      paymentHash: hash,
      state: "OPEN",
      amountMsat: AMOUNT_SATS * 1_000n,
      amountPaidMsat: 0n,
      htlcExpiryHeights: [],
    });
  });

  it("shows a paid hold invoice as ACCEPTED with the held HTLC's expiry height", async () => {
    await accepted();
    await expect(port.lookupInvoice(hash)).resolves.toEqual({
      paymentHash: hash,
      state: "ACCEPTED",
      amountMsat: AMOUNT_SATS * 1_000n,
      amountPaidMsat: AMOUNT_SATS * 1_000n,
      htlcExpiryHeights: [START_HEIGHT + CLTV_EXPIRY],
    });
  });

  it("settles idempotently, and then refuses to cancel", async () => {
    await accepted();
    await port.settleInvoice(preimage);
    await expect(port.settleInvoice(preimage)).resolves.toBeUndefined();
    await expect(port.cancelInvoice(hash)).rejects.toThrow();
    await expect(port.lookupInvoice(hash)).resolves.toMatchObject({ state: "SETTLED", htlcExpiryHeights: [] });
  });

  it("cancels idempotently, and then refuses to settle", async () => {
    await accepted();
    await port.cancelInvoice(hash);
    await expect(port.cancelInvoice(hash)).resolves.toBeUndefined();
    await expect(port.settleInvoice(preimage)).rejects.toThrow();
    await expect(port.lookupInvoice(hash)).resolves.toMatchObject({ state: "CANCELED", htlcExpiryHeights: [] });
  });

  it("refuses to settle a hold invoice nobody has paid", async () => {
    await createHold();
    await expect(port.settleInvoice(preimage)).rejects.toThrow();
  });

  it("refuses a second hold invoice on the same hash", async () => {
    await createHold();
    await expect(createHold()).rejects.toThrow();
  });
});
