import { rethrowAsHubError } from "../../common/utils/hub-error.util";
import { LEG_NETWORK_NAME, type LegNetwork } from "../../domain/swap";
import { SWAP_ERROR } from "./swap.errors";

/** Checks both direction flows run on the user's payout invoice at swap creation. Each throws a HubError. */

/** A node call a request waits for (creating or cancelling a swap): a failure means the node is unavailable (503). */
export const callNode = <T>(network: LegNetwork, call: () => Promise<T>): Promise<T> =>
  rethrowAsHubError(call, (cause) => SWAP_ERROR.nodeUnavailable(LEG_NETWORK_NAME[network], cause));

/** Decoding the user's invoice: a failure means it is not an invoice for that network (400). */
export const readPayoutInvoice = <T>(network: LegNetwork, read: () => Promise<T>): Promise<T> =>
  rethrowAsHubError(read, (cause) => SWAP_ERROR.invoiceUnreadable(LEG_NETWORK_NAME[network], cause));

/**
 * The invoice must be for a network the hub pays out on. `acceptedNetworks` lists the invoice networks the hub's node
 * can pay; by default only its own (Lightning widens it: testnet4 nodes pay "lntb" invoices, see BTC_INVOICE_NETWORKS).
 */
export function assertInvoiceNetwork<N extends string>(
  network: LegNetwork,
  invoiceNetwork: N,
  hubNetwork: N,
  acceptedNetworks: readonly N[] = [hubNetwork],
): void {
  if (!acceptedNetworks.includes(invoiceNetwork)) {
    throw SWAP_ERROR.invoiceWrongNetwork(LEG_NETWORK_NAME[network], invoiceNetwork, hubNetwork);
  }
}

/**
 * The invoice must ask for exactly the quoted amount: the nodes cannot pay an invoice without one, and the hub pays out
 * no more and no less than the quote. `describe` writes an amount for people.
 */
export function assertInvoiceAmount(invoiceAmount: bigint | null, quotedAmount: bigint, describe: (amount: bigint) => string): void {
  if (invoiceAmount === null) throw SWAP_ERROR.invoiceAmountMissing(describe(quotedAmount));
  if (invoiceAmount !== quotedAmount) throw SWAP_ERROR.invoiceAmountMismatch(describe(invoiceAmount), describe(quotedAmount));
}

/**
 * The invoice must stay payable until the quote expires: the user may pay the hold invoice up to that instant and the
 * payout follows right after. `invoiceExpiresAt` null means it never expires.
 */
export function assertInvoiceOutlivesQuote(invoiceExpiresAt: number | null, quoteExpiresAt: number, now: number): void {
  if (invoiceExpiresAt === null) return;
  if (invoiceExpiresAt <= now) throw SWAP_ERROR.invoiceExpired();
  if (invoiceExpiresAt < quoteExpiresAt) throw SWAP_ERROR.invoiceExpiresBeforeQuote(quoteExpiresAt);
}
