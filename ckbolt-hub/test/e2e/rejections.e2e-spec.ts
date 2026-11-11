import { API_ERROR_CODE } from "../../src/common/constants/api.constants";
import { FIBER_DEFAULT_HASH_ALGORITHM } from "../../src/common/constants/fiber-rpc.constants";
import { SWAP_DIRECTION, SWAP_STATE } from "../../src/common/constants/swap.constants";
import type { Direction, FiberAssetId } from "../../src/domain/types";
import { newPaymentSecret } from "../../devnet/scripts/lib/payment-secret";
import { createSwap, expectApiError, lightningSideQuote, postDemoInvoice, postQuote, postSwap } from "../support/hub-http";
import { swapSides } from "./support/devnet-nodes";
import { E2E_INVOICE_DESCRIPTION } from "./support/e2e.constants";
import { requireAsset, useE2eContext } from "./support/e2e-flow";

/**
 * Scenario 7: payout invoices and quotes the hub must refuse, made on the devnet's real user nodes. Each refusal comes
 * before the hub issues anything: no hold invoice appears on its nodes for the refused hash.
 */

/** Long enough to outlive any quote of the default QUOTE_TTL_SECONDS, short enough to vanish soon from the user nodes. */
const USER_INVOICE_EXPIRY_SECONDS = 600;

const DIRECTIONS: ReadonlyArray<[Direction, FiberAssetId, number]> = [
  [SWAP_DIRECTION.LN_TO_FIBER, "CKB", 2_401],
  [SWAP_DIRECTION.FIBER_TO_LN, "CKB", 2_402],
];

describe("rejected swaps", () => {
  const e2e = useE2eContext();

  it("refuses a Fiber payout invoice that uses the ckb_hash algorithm (422 invoice_invalid)", async () => {
    const hub = await e2e.startHub();
    const quote = await postQuote(hub, lightningSideQuote(SWAP_DIRECTION.LN_TO_FIBER, "CKB", 2_411n));
    const invoice = await e2e.nodes.fiber.user.newInvoice({
      amount: BigInt(quote.receive.amount),
      udtTypeScript: requireAsset(hub, "CKB").udtTypeScript,
      hashLock: { paymentPreimage: newPaymentSecret().preimage },
      expirySeconds: USER_INVOICE_EXPIRY_SECONDS,
      description: E2E_INVOICE_DESCRIPTION,
      hashAlgorithm: FIBER_DEFAULT_HASH_ALGORITHM,
    });

    const message = expectApiError(await postSwap(hub, quote.id, invoice), 422, API_ERROR_CODE.INVOICE_INVALID);
    expect(message).toContain(FIBER_DEFAULT_HASH_ALGORITHM);
  });

  it("refuses a Lightning payout invoice without an amount (422 invoice_invalid)", async () => {
    const hub = await e2e.startHub();
    const sides = swapSides(e2e.nodes, SWAP_DIRECTION.FIBER_TO_LN);
    const quote = await postQuote(hub, lightningSideQuote(SWAP_DIRECTION.FIBER_TO_LN, "CKB", 2_412n));
    const amountless = await e2e.nodes.lnd.user.addInvoice({ sats: null, expirySeconds: USER_INVOICE_EXPIRY_SECONDS });

    try {
      const message = expectApiError(await postSwap(hub, quote.id, amountless.payment_request), 422, API_ERROR_CODE.INVOICE_INVALID);
      expect(message).toContain("no amount");
      expect(await sides.holdInvoiceStatus(amountless.r_hash)).toBeNull();
    } finally {
      await e2e.nodes.lnd.user.cancelInvoice(amountless.r_hash);
    }
  });

  it.each(DIRECTIONS)("%s %s (%s sats): refuses a payout invoice whose hash another swap uses (409 duplicate_hash)", async (direction, assetId, sats) => {
    const hub = await e2e.startHub();
    const first = await postQuote(hub, lightningSideQuote(direction, assetId, BigInt(sats)));
    const payout = await postDemoInvoice(hub, first);
    const swap = await createSwap(hub, first.id, payout.invoice, true);
    expect(swap.state).toBe(SWAP_STATE.PENDING);

    const second = await postQuote(hub, lightningSideQuote(direction, assetId, BigInt(sats)));
    expectApiError(await postSwap(hub, second.id, payout.invoice, true), 409, API_ERROR_CODE.DUPLICATE_HASH);
  });

  it.each(DIRECTIONS)("%s %s (%s sats): refuses a second swap on the same quote (409 conflict)", async (direction, assetId, sats) => {
    const hub = await e2e.startHub();
    const sides = swapSides(e2e.nodes, direction);
    const quote = await postQuote(hub, lightningSideQuote(direction, assetId, BigInt(sats)));
    const firstPayout = await postDemoInvoice(hub, quote);
    await createSwap(hub, quote.id, firstPayout.invoice, true);

    const secondPayout = await postDemoInvoice(hub, quote);
    expectApiError(await postSwap(hub, quote.id, secondPayout.invoice, true), 409, API_ERROR_CODE.CONFLICT);
    expect(await sides.holdInvoiceStatus(secondPayout.paymentHash)).toBeNull();
  });
});
