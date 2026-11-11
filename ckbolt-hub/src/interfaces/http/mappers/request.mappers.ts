import type { DemoWallet } from "../../../application/demo/demo-wallet.contract";
import type { OpenInboundChannelInput } from "../../../application/fiber-node/inbound-channels.contract";
import type { OpenLnInboundChannelInput } from "../../../application/lightning-node/ln-inbound-channels.contract";
import type { CreateSwapInput } from "../../../application/swaps/swap-engine.contract";
import { fromDecimalString } from "../../../common/utils/amount.util";
import type { QuoteRequest } from "../../../domain/types";
import type {
  CreateDemoInvoiceBody,
  CreateInboundChannelBody,
  CreateLightningInboundChannelBody,
  CreateQuoteBody,
  CreateSwapBody,
} from "../contract/requests";

/** Validated request bodies -> application inputs. Amounts arrive as decimal strings of base units. */

type DemoInvoiceInput = Parameters<DemoWallet["createPayoutInvoice"]>[0];

export const toQuoteRequest = (body: CreateQuoteBody): QuoteRequest => ({
  direction: body.direction,
  asset: body.asset,
  side: body.side,
  amount: fromDecimalString(body.amount),
  purpose: body.purpose,
});

/** `demo` comes from the hub (DemoWallet.receivesPayout), never from the request; `clientKey` from requestClientKey. */
export const toCreateSwapInput = (body: CreateSwapBody, demo: boolean, clientKey: string): CreateSwapInput => ({
  quoteId: body.quoteId,
  payoutInvoice: body.payoutInvoice,
  demo,
  clientKey,
});

export const toDemoInvoiceInput = (body: CreateDemoInvoiceBody): DemoInvoiceInput => ({
  direction: body.direction,
  asset: body.asset,
  amount: fromDecimalString(body.amount),
});

/** `clientKey` from requestClientKey: the per-client daily cap counts the same key as the rate limits. */
export const toOpenInboundChannelInput = (body: CreateInboundChannelBody, clientKey: string): OpenInboundChannelInput => ({
  nodeId: body.nodeId,
  asset: body.asset,
  clientKey,
});

/** `clientKey` from requestClientKey: the per-client daily cap counts the same key as the rate limits. */
export const toOpenLnInboundChannelInput = (body: CreateLightningInboundChannelBody, clientKey: string): OpenLnInboundChannelInput => ({
  pubkey: body.pubkey,
  clientKey,
});
