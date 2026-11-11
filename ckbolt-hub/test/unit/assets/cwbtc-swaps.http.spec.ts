import { createHash } from "node:crypto";
import type { Direction, Hex32 } from "../../../src/domain/types";
import { createSwap, lightningSideQuote, postDemoInvoice, postDemoPayment, postQuote } from "../../support/hub-http";
import { CWBTC_SCRIPT, processUntilFinished, takeCkbFeedsDown, useAssetsHubs, type AssetsHub } from "./assets.fixtures";

/**
 * A cWBTC swap end to end on fake nodes, both ways, through the API with the demo wallet: the same engine and flows as
 * CKB and RUSD, keyed only by the asset's type script. cWBTC is at BTC parity with no option premium in the VPS example,
 * so 10,000 sats are 9,950 cWBTC base units after the 50 bps fee, and 10,000 sats cost 10,051 (rounded up).
 */

const SATS = 10_000n;
const sha256 = (hex: Hex32): Hex32 => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");

/** Quote, demo payout invoice, swap, demo payment, then engine passes until the swap is done. */
async function swapWithDemoWallet(hub: AssetsHub, direction: Direction) {
  const quote = await postQuote(hub, lightningSideQuote(direction, "CWBTC", SATS));
  const payout = await postDemoInvoice(hub, quote);
  const swap = await createSwap(hub, quote.id, payout.invoice);
  await postDemoPayment(hub, swap.id);
  return { quote, payout, swap, done: await processUntilFinished(hub, swap.id) };
}

describe("cWBTC swaps over HTTP (FIBER_ASSETS), with the fakes", () => {
  const hubs = useAssetsHubs();

  it("ln_to_fiber: the user pays 10,000 sats and receives 9,950 cWBTC base units over the hub's cWBTC channel", async () => {
    const hub = await hubs.start();
    const { quote, payout, done } = await swapWithDemoWallet(hub, "ln_to_fiber");

    expect(quote.receive).toEqual({ network: "fiber", asset: "CWBTC", amount: "9950", decimals: 8 });
    expect(done).toMatchObject({ asset: "CWBTC", state: "succeeded", refunded: false, failureReason: null });
    expect(sha256(done.preimage ?? "")).toBe(done.paymentHash);
    expect(await hub.userFiber.getInvoice(payout.paymentHash)).toMatchObject({ state: "Paid" });
    const parsed = await hub.hubFiber.parseInvoice(payout.invoice);
    expect(parsed).toMatchObject({ udtTypeScript: CWBTC_SCRIPT, amount: 9_950n });
  });

  it("fiber_to_ln: the user pays 10,051 cWBTC base units into the hub's cWBTC hold invoice and receives 10,000 sats", async () => {
    const hub = await hubs.start();
    const { quote, swap, done } = await swapWithDemoWallet(hub, "fiber_to_ln");

    expect(quote.pay).toEqual({ network: "fiber", asset: "CWBTC", amount: "10051", decimals: 8 });
    expect(done).toMatchObject({ asset: "CWBTC", state: "succeeded", refunded: false });
    expect(await hub.hubFiber.parseInvoice(swap.pay.invoice)).toMatchObject({ udtTypeScript: CWBTC_SCRIPT, amount: 10_051n });
    expect(await hub.hubFiber.getInvoice(done.paymentHash)).toMatchObject({ state: "Paid" });
  });

  it("swaps cWBTC both ways while the CKB price feeds are down", async () => {
    const hub = await hubs.start();
    takeCkbFeedsDown(hub);

    for (const direction of ["ln_to_fiber", "fiber_to_ln"] as const) {
      expect((await swapWithDemoWallet(hub, direction)).done.state).toBe("succeeded");
    }
  });

  it("refuses a payout invoice in another asset for a cWBTC quote (the invoice's UDT must be cWBTC)", async () => {
    const hub = await hubs.start();
    const quote = await postQuote(hub, lightningSideQuote("ln_to_fiber", "CWBTC", SATS));
    const rusdInvoice = await postDemoInvoice(hub, { ...quote, asset: "RUSD" });

    const res = await hub.http().post("/v1/swaps").send({ quoteId: quote.id, payoutInvoice: rusdInvoice.invoice });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("invoice_invalid");
  });
});
