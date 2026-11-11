import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { SWAP_STATE } from "../../../src/common/constants/swap.constants";
import type { AssetDto } from "../../../src/interfaces/http/contract/responses";
import {
  API_PATH,
  CKB_SHANNONS,
  createSwap,
  expectApiError,
  getSwap,
  HUB_FIBER_CHANNELS,
  lightningQuote,
  postDemoInvoice,
  postDemoPayment,
  postQuote,
  postSwap,
  processUntil,
  RUSD_SCRIPT,
  startFakeHub,
  startPaidDemoSwap,
  SWAP_SATS,
  userFiberInvoice,
  userLnInvoice,
  useHubLifecycle,
  type FakeHub,
} from "./integration.fixtures";

/**
 * Behaviours added in the integration step, checked end to end over HTTP on the real AppModule:
 * - a payout invoice without an amount is refused in both directions (422 invoice_invalid), leaving nothing behind;
 * - one swap per quote (409 conflict), also when two requests race for the same quote;
 * - quotes see the hub's payout liquidity less what open swaps have reserved, fee budgets included.
 */

const BASIS_POINTS_PER_WHOLE = 10_000n;

/** Worked out from docs/architecture.md (AssetDto.liquidity) by hand, not with the hub's own helpers. */
const ceilBps = (amount: bigint, bps: number): bigint => (amount * BigInt(bps) + BASIS_POINTS_PER_WHOLE - 1n) / BASIS_POINTS_PER_WHOLE;
const reservation = (payout: bigint, bps: number): bigint => payout + ceilBps(payout, bps);
const largestPayout = (available: bigint, bps: number): bigint =>
  available <= 0n ? 0n : (available * BASIS_POINTS_PER_WHOLE) / (BASIS_POINTS_PER_WHOLE + BigInt(bps));

async function listAssets(hub: FakeHub): Promise<Record<string, AssetDto["liquidity"]>> {
  const res = await hub.http().get(API_PATH.ASSETS).expect(200);
  return Object.fromEntries((res.body.data as AssetDto[]).map((asset) => [asset.id, asset.liquidity]));
}

describe("Integration behaviours over HTTP", () => {
  const lifecycle = useHubLifecycle();
  const start = async (options?: Parameters<typeof startFakeHub>[0]): Promise<FakeHub> => lifecycle.track(await startFakeHub(options));

  /* ------------------------------------------------------------------------------------- amountless invoices */

  describe("payout invoices without an amount", () => {
    it("ln_to_fiber: an amountless Fiber invoice is refused with 422 invoice_invalid naming the quoted amount", async () => {
      const hub = await start();
      for (const [asset, udt] of [["CKB", null], ["RUSD", RUSD_SCRIPT]] as const) {
        const quote = await postQuote(hub, lightningQuote("ln_to_fiber", asset));
        const amountless = userFiberInvoice(hub, null, udt);

        const message = expectApiError(await postSwap(hub, quote.id, amountless.invoice), 422, API_ERROR_CODE.INVOICE_INVALID);

        expect(message).toMatch(/no amount/i);
        expect(message).toContain(asset);
        expect(hub.ln.invoices.has(amountless.paymentHash)).toBe(false);
      }
      expect(hub.hubLn.calls).not.toContain("createHoldInvoice");
    });

    it("fiber_to_ln: an amountless BOLT11 invoice is refused with 422 invoice_invalid naming the quoted sats", async () => {
      const hub = await start();
      const quote = await postQuote(hub, lightningQuote("fiber_to_ln", "CKB"));
      const amountless = userLnInvoice(hub, null);

      const message = expectApiError(await postSwap(hub, quote.id, amountless.invoice), 422, API_ERROR_CODE.INVOICE_INVALID);

      expect(message).toMatch(/no amount/i);
      expect(message).toContain(`${SWAP_SATS} sats`);
      expect(hub.fiber.invoices.has(amountless.paymentHash)).toBe(false);
      expect(hub.hubFiber.calls).not.toContain("createHoldInvoice");
    });

    it.each(["ln_to_fiber", "fiber_to_ln"] as const)("%s: the refused request leaves the quote free for an invoice with the amount", async (direction) => {
      const hub = await start();
      const quote = await postQuote(hub, lightningQuote(direction, "CKB"));
      const amountless = direction === "ln_to_fiber" ? userFiberInvoice(hub, null) : userLnInvoice(hub, null);
      expectApiError(await postSwap(hub, quote.id, amountless.invoice), 422, API_ERROR_CODE.INVOICE_INVALID);

      const exact = direction === "ln_to_fiber" ? userFiberInvoice(hub, BigInt(quote.receive.amount)) : userLnInvoice(hub, SWAP_SATS);
      const swap = await createSwap(hub, quote.id, exact.invoice);
      expect(swap).toMatchObject({ state: SWAP_STATE.PENDING, paymentHash: exact.paymentHash, receive: { amount: quote.receive.amount } });
    });
  });

  /* ---------------------------------------------------------------------------------------- one swap per quote */

  describe("one swap per quote", () => {
    it.each(["ln_to_fiber", "fiber_to_ln"] as const)("%s: a second swap on the quote is 409 conflict, whatever its invoice", async (direction) => {
      const hub = await start();
      const quote = await postQuote(hub, lightningQuote(direction, "CKB"));
      const payout = await postDemoInvoice(hub, quote);
      const first = await createSwap(hub, quote.id, payout.invoice, true);

      expectApiError(await postSwap(hub, quote.id, payout.invoice, true), 409, API_ERROR_CODE.CONFLICT);
      const other = await postDemoInvoice(hub, quote);
      expectApiError(await postSwap(hub, quote.id, other.invoice, true), 409, API_ERROR_CODE.CONFLICT);

      expect(hub.store.getSwapByQuoteId(quote.id)?.id).toBe(first.id);
      expect(hub.store.listOpenSwaps().map((swap) => swap.id)).toEqual([first.id]);
    });

    it("a quote whose swap has finished cannot start another one", async () => {
      const hub = await start();
      const { quote, swap } = await startPaidDemoSwap(hub, "ln_to_fiber", "CKB");
      expect((await processUntil(hub, swap.id)).state).toBe(SWAP_STATE.SUCCEEDED);

      const again = await postDemoInvoice(hub, quote);
      expectApiError(await postSwap(hub, quote.id, again.invoice, true), 409, API_ERROR_CODE.CONFLICT);
    });

    it("two requests racing for one quote: one 201, one 409 conflict, and the loser's hold invoice is cancelled", async () => {
      const hub = await start();
      const quote = await postQuote(hub, lightningQuote("fiber_to_ln", "CKB"));
      const invoices = [userLnInvoice(hub, SWAP_SATS), userLnInvoice(hub, SWAP_SATS)];

      // Both requests get past the early "quote already used" check before either saves its swap.
      const createHoldInvoice = hub.hubFiber.createHoldInvoice.bind(hub.hubFiber);
      let arrived = 0;
      let releaseBoth: () => void = () => undefined;
      const bothArrived = new Promise<void>((resolve) => (releaseBoth = resolve));
      jest.spyOn(hub.hubFiber, "createHoldInvoice").mockImplementation(async (args) => {
        arrived += 1;
        if (arrived === invoices.length) releaseBoth();
        await bothArrived;
        return createHoldInvoice(args);
      });

      const responses = await Promise.all(invoices.map(({ invoice }) => postSwap(hub, quote.id, invoice)));

      expect(responses.map((res) => res.status).sort()).toEqual([201, 409]);
      const loserIndex = responses.findIndex((res) => res.status === 409);
      const winnerIndex = 1 - loserIndex;
      expectApiError(responses[loserIndex]!, 409, API_ERROR_CODE.CONFLICT);
      expect(responses[winnerIndex]!.body.paymentHash).toBe(invoices[winnerIndex]!.paymentHash);
      expect((await hub.hubFiber.getInvoice(invoices[loserIndex]!.paymentHash))?.state).toBe("Cancelled");
      expect((await hub.hubFiber.getInvoice(invoices[winnerIndex]!.paymentHash))?.state).toBe("Open");
      expect(hub.store.listOpenSwaps()).toHaveLength(1);
    });
  });

  /* ---------------------------------------------------------------------------------------- liquidity reservation */

  describe("liquidity reservation", () => {
    /**
     * These tests are about what open swaps reserve, so they let unpaid swaps take the whole liquidity: by default
     * (SWAP_MAX_UNPAID_SHARE_PERCENT=50) unpaid swaps may hold only half of it, which the last test here checks.
     */
    const WHOLE_SHARE_FOR_UNPAID = { SWAP_MAX_UNPAID_SHARE_PERCENT: "100" };

    it("fiber_to_ln: an open swap reserves its Lightning payout plus fee budget until it finishes", async () => {
      const balance = 25_000n;
      const hub = await start({ hubLnBalances: { channelLocalSats: balance }, env: WHOLE_SHARE_FOR_UNPAID });
      const bps = hub.config.swaps.lnMaxFeeBps;
      const full = largestPayout(balance, bps);
      expect((await listAssets(hub)).CKB?.lightningSats).toBe(full.toString());

      const firstPayout = 20_000n;
      const quote = await postQuote(hub, lightningQuote("fiber_to_ln", "CKB", firstPayout));
      // A quote alone reserves nothing: only a swap does.
      expect((await listAssets(hub)).CKB?.lightningSats).toBe(full.toString());
      const swap = await createSwap(hub, quote.id, userLnInvoice(hub, firstPayout).invoice);

      const left = largestPayout(balance - reservation(firstPayout, bps), bps);
      const liquidity = await listAssets(hub);
      expect(liquidity.CKB?.lightningSats).toBe(left.toString());
      // Every fiber_to_ln payout uses the same Lightning channels, whatever the asset paid in.
      expect(liquidity.RUSD?.lightningSats).toBe(left.toString());

      const tooBig = await hub.http().post(API_PATH.QUOTES).send(lightningQuote("fiber_to_ln", "RUSD", left + 1n));
      expect(expectApiError(tooBig, 422, API_ERROR_CODE.INSUFFICIENT_LIQUIDITY)).toContain(`${left} sats`);
      await postQuote(hub, lightningQuote("fiber_to_ln", "RUSD", left));
      // The other direction pays out on Fiber, so it is not affected.
      await postQuote(hub, lightningQuote("ln_to_fiber", "CKB", firstPayout));

      hub.clock.set(Date.parse(quote.expiresAt) + 1);
      expect((await processUntil(hub, swap.id)).state).toBe(SWAP_STATE.FAILED);
      expect((await listAssets(hub)).CKB?.lightningSats).toBe(full.toString());
    });

    it("ln_to_fiber: an open swap reserves its Fiber payout in its own asset only, until the payout is sent", async () => {
      const ckbBalance = 10_000n * CKB_SHANNONS;
      const rusdBalance = 5_000n * CKB_SHANNONS;
      const channels = HUB_FIBER_CHANNELS.map((channel) => ({ ...channel, localBalance: channel.udtTypeScript ? rusdBalance : ckbBalance }));
      const hub = await start({ hubFiberChannels: channels });
      const bps = hub.config.swaps.fiberMaxFeeBps;
      const before = await listAssets(hub);
      expect(before.CKB?.fiberAmount).toBe(largestPayout(ckbBalance, bps).toString());
      expect(before.RUSD?.fiberAmount).toBe(largestPayout(rusdBalance, bps).toString());

      const quote = await postQuote(hub, lightningQuote("ln_to_fiber", "CKB"));
      const payout = await postDemoInvoice(hub, quote);
      hub.fiber.setPayoutBehavior(payout.paymentHash, "hang");
      const swap = await createSwap(hub, quote.id, payout.invoice, true);
      const payoutAmount = BigInt(quote.receive.amount);

      const pending = await listAssets(hub);
      expect(pending.CKB?.fiberAmount).toBe(largestPayout(ckbBalance - reservation(payoutAmount, bps), bps).toString());
      expect(pending.RUSD?.fiberAmount).toBe(before.RUSD?.fiberAmount);
      expect(pending.CKB?.lightningSats).toBe(before.CKB?.lightningSats);

      await postDemoPayment(hub, swap.id);
      await processUntil(hub, swap.id, (s) => s.state === SWAP_STATE.OUTGOING_IN_FLIGHT);
      // Once sent, the payout is out of the channel balance itself (docs/architecture.md): no double count.
      expect((await listAssets(hub)).CKB?.fiberAmount).toBe(before.CKB?.fiberAmount);
      expect((await getSwap(hub, swap.id)).state).toBe(SWAP_STATE.OUTGOING_IN_FLIGHT);
    });

    it("reservations of several open swaps add up, and a quote that no longer fits is refused", async () => {
      const balance = 30_000n;
      const hub = await start({ hubLnBalances: { channelLocalSats: balance }, env: WHOLE_SHARE_FOR_UNPAID });
      const bps = hub.config.swaps.lnMaxFeeBps;
      const payouts = [12_000n, 11_000n];
      for (const sats of payouts) {
        const quote = await postQuote(hub, lightningQuote("fiber_to_ln", "CKB", sats));
        await createSwap(hub, quote.id, userLnInvoice(hub, sats).invoice);
      }
      const reserved = payouts.reduce((sum, sats) => sum + reservation(sats, bps), 0n);
      const left = largestPayout(balance - reserved, bps);

      expect((await listAssets(hub)).CKB?.lightningSats).toBe(left.toString());
      const refused = await hub.http().post(API_PATH.QUOTES).send(lightningQuote("fiber_to_ln", "CKB", 7_000n));
      expectApiError(refused, 422, API_ERROR_CODE.INSUFFICIENT_LIQUIDITY);
      expect(left).toBeLessThan(7_000n);
    });

    it("unpaid swaps together hold at most SWAP_MAX_UNPAID_SHARE_PERCENT of a direction's liquidity: past it, 503 insufficient_liquidity and no hold invoice", async () => {
      const balance = 25_000n;
      const hub = await start({ hubLnBalances: { channelLocalSats: balance } });
      expect(hub.config.swaps.maxUnpaidSharePercent).toBe(50);

      // 20,000 sats fit the balance (the quote is made) but not half of it: the swap is refused before any node call.
      const big = await postQuote(hub, lightningQuote("fiber_to_ln", "CKB", 20_000n));
      const holdInvoices = jest.spyOn(hub.hubFiber, "createHoldInvoice");
      const refused = await postSwap(hub, big.id, userLnInvoice(hub, 20_000n).invoice);
      expect(expectApiError(refused, 503, API_ERROR_CODE.INSUFFICIENT_LIQUIDITY)).toMatch(/Lightning liquidity/);
      expect(holdInvoices).not.toHaveBeenCalled();
      expect(hub.store.listOpenSwaps()).toHaveLength(0);

      // 10,000 sats and their fee budget fit in the 12,500 share.
      const small = await postQuote(hub, lightningQuote("fiber_to_ln", "CKB", 10_000n));
      await createSwap(hub, small.id, userLnInvoice(hub, 10_000n).invoice);
      expect(hub.store.listOpenSwaps()).toHaveLength(1);
    });
  });
});
