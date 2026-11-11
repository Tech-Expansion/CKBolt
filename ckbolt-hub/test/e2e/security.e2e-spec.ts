import { API_ERROR_CODE } from "../../src/common/constants/api.constants";
import { SWAP_DIRECTION, SWAP_STATE } from "../../src/common/constants/swap.constants";
import { newPaymentSecret } from "../../devnet/scripts/lib/payment-secret";
import { API_PATH, createSwap, expectApiError, lightningSideQuote, postDemoInvoice, postQuote, postSwap } from "../support/hub-http";
import { swapSides } from "./support/devnet-nodes";
import { E2E_INVOICE_DESCRIPTION } from "./support/e2e.constants";
import { requireAsset, useE2eContext } from "./support/e2e-flow";

/**
 * Scenario 8: the security review's rules on the devnet's real nodes. The demo wallet funds only swaps that pay out to
 * its own nodes, and works out the swap's demo flag itself; the hub refuses Fiber payout invoices that allow MPP,
 * Lightning payout invoices whose CLTV would lock its funds longer than the profile's cap, and a client's swap past its
 * cap of swaps waiting for their payment. Nothing is paid in any case.
 */

/** Long enough to outlive any quote of the default QUOTE_TTL_SECONDS, short enough to vanish soon from the nodes. */
const INVOICE_EXPIRY_SECONDS = 600;
/**
 * Regtest caps a payout lock at 48 h = 192 slow blocks: 109 + 3 padding + 1 (LND wants the limit above the padded CLTV)
 * + 80 route budget = 193 does not fit.
 */
const CLTV_ABOVE_REGTEST_CAP = 109;

describe("security rules", () => {
  const e2e = useE2eContext();

  it("the demo wallet refuses (409) to pay for a swap whose payout goes to another node, and the swap is not a demo swap", async () => {
    const hub = await e2e.startHub();
    const sides = swapSides(e2e.nodes, SWAP_DIRECTION.FIBER_TO_LN);
    const quote = await postQuote(hub, lightningSideQuote(SWAP_DIRECTION.FIBER_TO_LN, "CKB", 2_501n));
    // Any node but the demo wallet's: here the hub's own LND stands in for an attacker's wallet.
    const foreign = await e2e.nodes.lnd.hub.addInvoice({ sats: BigInt(quote.receive.amount), expirySeconds: INVOICE_EXPIRY_SECONDS });

    try {
      const swap = await createSwap(hub, quote.id, foreign.payment_request, true);
      expect(swap.demo).toBe(false);

      const res = await hub.http().post(API_PATH.DEMO_PAYMENTS).send({ swapId: swap.id });
      expectApiError(res, 409, API_ERROR_CODE.CONFLICT);
      expect(await sides.holdInvoiceStatus(swap.paymentHash)).toBe(sides.states.hold.open);
      await expect(sides.userPayment(swap.paymentHash)).rejects.toThrow();
    } finally {
      await e2e.nodes.lnd.hub.cancelInvoice(foreign.r_hash);
    }
  });

  it("a swap paying out to the demo wallet's invoice is a demo swap, whatever the request says", async () => {
    const hub = await e2e.startHub();
    const quote = await postQuote(hub, lightningSideQuote(SWAP_DIRECTION.LN_TO_FIBER, "CKB", 2_502n));
    const payout = await postDemoInvoice(hub, quote);
    const swap = await createSwap(hub, quote.id, payout.invoice, false);
    expect(swap).toMatchObject({ state: SWAP_STATE.PENDING, demo: true });
  });

  it("refuses a Fiber payout invoice that allows multi-part payments (422 invoice_invalid)", async () => {
    const hub = await e2e.startHub();
    const sides = swapSides(e2e.nodes, SWAP_DIRECTION.LN_TO_FIBER);
    const quote = await postQuote(hub, lightningSideQuote(SWAP_DIRECTION.LN_TO_FIBER, "CKB", 2_503n));
    const { preimage, paymentHash } = newPaymentSecret();
    const invoice = await e2e.nodes.fiber.user.newInvoice({
      amount: BigInt(quote.receive.amount),
      udtTypeScript: requireAsset(hub, "CKB").udtTypeScript,
      hashLock: { paymentPreimage: preimage },
      expirySeconds: INVOICE_EXPIRY_SECONDS,
      description: E2E_INVOICE_DESCRIPTION,
      allowMpp: true,
    });

    try {
      const message = expectApiError(await postSwap(hub, quote.id, invoice), 422, API_ERROR_CODE.INVOICE_INVALID);
      expect(message).toMatch(/multi-part/);
      expect(await sides.holdInvoiceStatus(paymentHash)).toBeNull();
    } finally {
      await e2e.nodes.fiber.user.cancelInvoice(paymentHash);
    }
  });

  it("refuses (429) a client's next swap once it has SWAP_MAX_UNPAID_PER_CLIENT waiting for their payment", async () => {
    const hub = await e2e.startHub({ env: { SWAP_MAX_UNPAID_PER_CLIENT: "1" } });
    const sides = swapSides(e2e.nodes, SWAP_DIRECTION.FIBER_TO_LN);
    const userInvoiceHashes: string[] = [];
    /** POST /v1/swaps for a fresh quote, paying out to a new invoice of the user's LND. */
    const requestSwap = async (sats: bigint) => {
      const quote = await postQuote(hub, lightningSideQuote(SWAP_DIRECTION.FIBER_TO_LN, "CKB", sats));
      const invoice = await e2e.nodes.lnd.user.addInvoice({ sats: BigInt(quote.receive.amount), expirySeconds: INVOICE_EXPIRY_SECONDS });
      userInvoiceHashes.push(invoice.r_hash);
      return { paymentHash: invoice.r_hash, res: await postSwap(hub, quote.id, invoice.payment_request) };
    };

    try {
      expect((await requestSwap(2_505n)).res.status).toBe(201);
      const refused = await requestSwap(2_506n);
      expectApiError(refused.res, 429, API_ERROR_CODE.RATE_LIMITED);
      expect(await sides.holdInvoiceStatus(refused.paymentHash)).toBeNull();
    } finally {
      for (const paymentHash of userInvoiceHashes) await e2e.nodes.lnd.user.cancelInvoice(paymentHash);
    }
  });

  it("refuses a Lightning payout invoice whose CLTV would lock the hub's payout past the profile's cap (422)", async () => {
    const hub = await e2e.startHub();
    const sides = swapSides(e2e.nodes, SWAP_DIRECTION.FIBER_TO_LN);
    const quote = await postQuote(hub, lightningSideQuote(SWAP_DIRECTION.FIBER_TO_LN, "CKB", 2_504n));
    const invoice = await e2e.nodes.lnd.user.addInvoice({
      sats: BigInt(quote.receive.amount),
      expirySeconds: INVOICE_EXPIRY_SECONDS,
      cltvExpiryDelta: CLTV_ABOVE_REGTEST_CAP,
    });

    try {
      const message = expectApiError(await postSwap(hub, quote.id, invoice.payment_request), 422, API_ERROR_CODE.INVOICE_INVALID);
      expect(message).toContain("CLTV");
      expect(await sides.holdInvoiceStatus(invoice.r_hash)).toBeNull();
    } finally {
      await e2e.nodes.lnd.user.cancelInvoice(invoice.r_hash);
    }
  });
});
