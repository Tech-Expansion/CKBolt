import { BackgroundTask } from "../lib/background-task";
import { waitOptions, type DevnetContext } from "../lib/context";
import { LND_INVOICE_STATE, LND_PAYMENT_STATUS } from "../lib/devnet.constants";
import { newPaymentSecret } from "../lib/payment-secret";
import { doneWhen, waitFor } from "../lib/poll";

/**
 * The hub's Lightning leg in miniature: lnd-hub creates a hold invoice for a hash the payer side chose, lnd-user pays
 * it, the hub sees ACCEPTED (the HTLC is held), settles with the preimage, and the payer ends SUCCEEDED with it.
 */
export async function lightningHoldInvoiceSmoke(ctx: DevnetContext): Promise<void> {
  const { lnd, logger, settings } = ctx;
  logger.step("Smoke: Lightning hold invoice on lnd-hub, paid by lnd-user, settled");
  const { preimage, paymentHash } = newPaymentSecret();
  const paymentRequest = await lnd.hub.addHoldInvoice({
    paymentHash,
    sats: settings.smoke.lnSats,
    cltvExpiryDelta: settings.smoke.lnCltvExpiryDelta,
    expirySeconds: settings.smoke.invoiceExpirySeconds,
  });
  logger.info(`hold invoice for ${settings.smoke.lnSats} sats, hash ${paymentHash}`);

  const payer = new BackgroundTask(
    "lnd-user's payment",
    lnd.user.payInvoice(paymentRequest, { feeLimitSats: settings.smoke.lnFeeLimitSats, timeoutSeconds: settings.smoke.lnPayTimeoutSeconds }),
  );
  await waitFor(
    "lnd-hub to hold the payment (ACCEPTED)",
    async () => {
      payer.assertRunning();
      return doneWhen((await lnd.hub.lookupInvoice(paymentHash)).state === LND_INVOICE_STATE.ACCEPTED);
    },
    waitOptions(ctx),
  );
  logger.info(`ACCEPTED: the HTLC is held; keeping it for ${settings.smoke.holdMs} ms`);
  await ctx.clock.sleep(settings.smoke.holdMs);
  const held = await lnd.hub.lookupInvoice(paymentHash);
  if (held.state !== LND_INVOICE_STATE.ACCEPTED) throw new Error(`The hold did not last: the invoice is ${held.state}`);

  await lnd.hub.settleInvoice(preimage);
  await payer.result();
  await waitFor("lnd-hub to settle", async () => doneWhen((await lnd.hub.lookupInvoice(paymentHash)).state === LND_INVOICE_STATE.SETTLED), waitOptions(ctx));

  const payment = await lnd.user.findPayment(paymentHash);
  if (payment?.status !== LND_PAYMENT_STATUS.SUCCEEDED) throw new Error(`lnd-user's payment ended ${payment?.status ?? "missing"}`);
  if (payment.payment_preimage !== preimage) throw new Error("lnd-user received a different preimage");
  logger.info("SETTLED; the payer learned the preimage");
}
