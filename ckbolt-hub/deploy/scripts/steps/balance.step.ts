import { ceilDiv, minBigint } from "../../../src/common/utils/amount.util";
import type { DeployContext } from "../lib/context";
import { LND_PAYMENT_STATUS, MUTINYNET_FAUCET, MUTINYNET_LSP, SERVICE } from "../lib/constants";
import { balancesWith } from "../lib/lnd";

/** How many faucet invoices to pay: enough to reach the target, within the run's cap and the faucet's daily limit. */
export function balancingInvoiceCount(remote: bigint, target: bigint, invoiceSats: bigint, maxInvoices: number): number {
  if (remote >= target) return 0;
  const needed = ceilDiv(target - remote, invoiceSats);
  return Number(minBigint(needed, BigInt(maxInvoices), BigInt(MUTINYNET_FAUCET.INVOICES_PER_DAY)));
}

/**
 * Inbound Lightning liquidity without any login: lnd-hub pays invoices of the Mutinynet faucet's node through its
 * channel to the LSP. Each payment moves sats to the LSP's side of that channel, the side testers' wallets behind the
 * LSP pay the hub through; swaps that pay the hub use it up, and this tops it up again.
 */
export async function balanceLightning(ctx: DeployContext): Promise<void> {
  const { pubkey: lsp } = ctx.settings.peers.lnLspNode;
  const { inboundTargetSats, balanceInvoiceSats, balanceMaxInvoices, payFeeLimitSats, payTimeoutSeconds } = ctx.settings.lightning;
  ctx.logger.step(`Inbound Lightning liquidity in the channel to ${MUTINYNET_LSP.LABEL}`);
  const hub = ctx.lnd[SERVICE.LND_HUB];
  const before = balancesWith(await hub.channels(), lsp);
  if (before.active === 0) throw new Error(`lnd-hub has no active channel with ${MUTINYNET_LSP.LABEL}: run \`testnet channels\` and wait for confirmations`);

  const count = balancingInvoiceCount(before.remote, inboundTargetSats, balanceInvoiceSats, balanceMaxInvoices);
  ctx.logger.info(`now: ${before.local} sats outbound, ${before.remote} inbound; target ${inboundTargetSats} inbound`);
  for (let paid = 0; paid < count; paid += 1) {
    const invoice = await ctx.mutinynetFaucet.invoice(balanceInvoiceSats);
    const payment = await hub.payInvoice(invoice, {
      feeLimitSats: payFeeLimitSats,
      timeoutSeconds: payTimeoutSeconds,
      callTimeoutMs: ctx.settings.timeouts.commandMs,
    });
    if (payment.status !== LND_PAYMENT_STATUS.SUCCEEDED) {
      ctx.logger.warn(`payment ${paid + 1} of ${count} ended ${payment.status} (${payment.failure_reason}); stopping`);
      break;
    }
    ctx.logger.info(`paid ${balanceInvoiceSats} sats to the faucet (${paid + 1} of ${count})`);
  }
  const after = balancesWith(await hub.channels(), lsp);
  ctx.logger.info(`done: ${after.local} sats outbound, ${after.remote} inbound`);
}
