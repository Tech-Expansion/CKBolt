import {
  cancelHodlInvoice,
  createHodlInvoice,
  createInvoice,
  decodePaymentRequest,
  getChainBalance,
  getChannelBalance,
  getInvoice,
  getPayment,
  getWalletInfo,
  settleHodlInvoice,
  subscribeToInvoices,
  subscribeToPastPayment,
  subscribeToPayViaRequest,
} from "lightning";

/**
 * The `lightning` package calls the LND adapter makes. The adapter receives this object through its constructor, so
 * tests can hand it fakes instead of talking to a node.
 */
export const lndRpc = {
  cancelHodlInvoice,
  createHodlInvoice,
  createInvoice,
  decodePaymentRequest,
  getChainBalance,
  getChannelBalance,
  getInvoice,
  getPayment,
  getWalletInfo,
  settleHodlInvoice,
  subscribeToInvoices,
  subscribeToPastPayment,
  subscribeToPayViaRequest,
};

export type LndRpc = typeof lndRpc;
