import { HOLD_INVOICE_DESCRIPTION } from "../../../src/common/constants/swap.constants";
import type { Direction, FiberAssetId } from "../../../src/domain/types";
import { makeSwapHarness, silenceLogs, startSwap, type SwapHarness } from "./swaps.fixtures";

/**
 * Security review H4: a swap id lets anyone read the swap, and a hold invoice is seen by wallets, payers and every node
 * on its route. Both flows create their hold invoices with the fixed HOLD_INVOICE_DESCRIPTION, never the swap id. The
 * fake nodes record each hold invoice request as the hub sent it.
 */

/** What the description says, spelled out, so a change to the constant itself shows up here. */
const EXPECTED_DESCRIPTION = "CKBolt swap";

/** The text of every hold invoice request the hub's nodes took: the Fiber description and the Lightning memo. */
const holdInvoiceTexts = (h: SwapHarness): string[] => [
  ...h.hubFiber.holdInvoiceRequests.map((request) => request.description),
  ...h.hubLn.holdInvoiceRequests.map((request) => request.memo),
];

describe("hold invoice description (security review H4)", () => {
  let h: SwapHarness;

  beforeEach(() => {
    silenceLogs();
    h = makeSwapHarness();
  });
  afterEach(() => jest.restoreAllMocks());

  it("is exactly 'CKBolt swap'", () => {
    expect(HOLD_INVOICE_DESCRIPTION).toBe(EXPECTED_DESCRIPTION);
  });

  it("fiber_to_ln: the Fiber hold invoice's description is 'CKBolt swap' and names no swap", async () => {
    const { swap } = await startSwap(h, "fiber_to_ln");

    expect(h.hubFiber.holdInvoiceRequests).toHaveLength(1);
    const [request] = h.hubFiber.holdInvoiceRequests;
    expect(request?.description).toBe(EXPECTED_DESCRIPTION);
    expect(request?.description).not.toContain(swap.id);
    expect(request?.paymentHash).toBe(swap.paymentHash);
  });

  it("ln_to_fiber: the Lightning hold invoice's memo is 'CKBolt swap' and names no swap", async () => {
    const { swap } = await startSwap(h, "ln_to_fiber");

    expect(h.hubLn.holdInvoiceRequests).toHaveLength(1);
    const [request] = h.hubLn.holdInvoiceRequests;
    expect(request?.memo).toBe(EXPECTED_DESCRIPTION);
    expect(request?.memo).not.toContain(swap.id);
    expect(request?.paymentHash).toBe(swap.paymentHash);
  });

  it("ln_to_fiber: the hold invoice the user is given carries the same text (decoded from the invoice itself)", async () => {
    const { swap } = await startSwap(h, "ln_to_fiber");

    expect((await h.hubLn.decodeInvoice(swap.holdInvoice)).description).toBe(EXPECTED_DESCRIPTION);
  });

  it.each<[Direction, FiberAssetId]>([
    ["fiber_to_ln", "CKB"],
    ["fiber_to_ln", "RUSD"],
    ["ln_to_fiber", "CKB"],
    ["ln_to_fiber", "RUSD"],
  ])("%s in %s: no part of the hold invoice request carries the swap id", async (direction, asset) => {
    const { swap } = await startSwap(h, direction, { asset });

    const requests = [...h.hubFiber.holdInvoiceRequests, ...h.hubLn.holdInvoiceRequests];
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))).not.toContain(swap.id);
  });

  it("gives every swap the same text, so invoices cannot be told apart by it", async () => {
    await startSwap(h, "fiber_to_ln");
    await startSwap(h, "fiber_to_ln");
    await startSwap(h, "ln_to_fiber");
    await startSwap(h, "ln_to_fiber");

    expect(holdInvoiceTexts(h)).toEqual([EXPECTED_DESCRIPTION, EXPECTED_DESCRIPTION, EXPECTED_DESCRIPTION, EXPECTED_DESCRIPTION]);
  });
});
