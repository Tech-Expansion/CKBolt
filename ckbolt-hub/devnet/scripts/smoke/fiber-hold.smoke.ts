import { ASSET_METADATA, type KnownAssetId } from "../../../src/common/constants/assets.constants";
import { UNKNOWN_PAYMENT_FAILURE } from "../../../src/common/constants/swap.constants";
import { with0x, without0x } from "../../../src/common/utils/hex.util";
import { formatBaseUnits } from "../../../src/common/utils/pricing.util";
import type { Script } from "../../../src/domain/types";
import { waitOptions, type DevnetContext, type FiberNodes } from "../lib/context";
import { FNN_INVOICE_STATUS, FNN_PAYMENT_STATUS } from "../lib/devnet.constants";
import type { FiberNode, FnnPayment } from "../lib/fiber";
import { newPaymentSecret } from "../lib/payment-secret";
import { doneWhen, waitFor } from "../lib/poll";

export interface FiberSmokeAsset {
  asset: KnownAssetId;
  amount: bigint;
  /** null for CKB. */
  udtTypeScript: Script | null;
}

const SMOKE_DESCRIPTION = "ckbolt devnet smoke test";

/**
 * The hub's Fiber leg in miniature: fnn-hub creates a sha256 hold invoice for a hash the payer side chose, fnn-user
 * pays it, the hub sees Received and the TLC held in its channel, settles with the preimage, the invoice ends Paid
 * and the payer's payment ends Success carrying the preimage.
 */
export async function fiberHoldInvoiceSmoke(ctx: DevnetContext, fiber: FiberNodes, spec: FiberSmokeAsset): Promise<void> {
  const { logger, settings } = ctx;
  logger.step(`Smoke: Fiber sha256 hold invoice on fnn-hub (${spec.asset}), paid by fnn-user, settled`);
  const userPubkey = (await fiber.user.nodeInfo()).pubkey;
  const { preimage, paymentHash } = newPaymentSecret();
  const invoice = await fiber.hub.newInvoice({
    amount: spec.amount,
    udtTypeScript: spec.udtTypeScript,
    hashLock: { paymentHash },
    expirySeconds: settings.smoke.invoiceExpirySeconds,
    finalExpiryDeltaMs: settings.smoke.fiberFinalExpiryDeltaMs,
    description: SMOKE_DESCRIPTION,
  });
  logger.info(`hold invoice for ${formatBaseUnits(spec.amount, ASSET_METADATA[spec.asset].decimals)} ${spec.asset}, hash ${paymentHash}`);

  await fiber.user.sendPayment(invoice);
  await waitFor(
    "fnn-hub to hold the payment (Received, TLC pending)",
    async () => {
      assertNotFailed(await fiber.user.getPayment(paymentHash));
      const { status } = await fiber.hub.getInvoice(paymentHash);
      return doneWhen(status === FNN_INVOICE_STATUS.RECEIVED && (await holdsTlc(fiber.hub, userPubkey, paymentHash)));
    },
    waitOptions(ctx),
  );
  logger.info(`Received: the TLC is held in the channel; keeping it for ${settings.smoke.holdMs} ms`);
  await ctx.clock.sleep(settings.smoke.holdMs);
  if (!(await holdsTlc(fiber.hub, userPubkey, paymentHash))) throw new Error("The hold did not last: the TLC is gone");

  await fiber.hub.settleInvoice(paymentHash, preimage);
  await waitFor("fnn-hub's invoice to be Paid", async () => doneWhen((await fiber.hub.getInvoice(paymentHash)).status === FNN_INVOICE_STATUS.PAID), waitOptions(ctx));
  const payment = await waitFor(
    "fnn-user's payment to succeed",
    async () => {
      const current = assertNotFailed(await fiber.user.getPayment(paymentHash));
      return current.status === FNN_PAYMENT_STATUS.SUCCESS ? current : undefined;
    },
    waitOptions(ctx),
  );
  if (without0x(payment.payment_preimage ?? "") !== preimage) throw new Error("fnn-user received a different preimage");
  logger.info("Paid; the payer learned the preimage");
}

function assertNotFailed(payment: FnnPayment): FnnPayment {
  if (payment.status === FNN_PAYMENT_STATUS.FAILED) throw new Error(`fnn-user's payment failed: ${payment.failed_error ?? UNKNOWN_PAYMENT_FAILURE}`);
  return payment;
}

/** The hub's channel with the payer holds a TLC for the hash (an invoice can say Received after its TLC timed out). */
async function holdsTlc(hub: FiberNode, peerPubkey: string, paymentHash: string): Promise<boolean> {
  const hash = with0x(paymentHash);
  const channels = await hub.channelsWith(peerPubkey);
  return channels.some((channel) => channel.pending_tlcs.some((tlc) => tlc.payment_hash === hash));
}
