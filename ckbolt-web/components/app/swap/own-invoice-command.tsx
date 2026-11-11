"use client";

import { useHubClient } from "@/hooks/use-hub-client";
import type { QuoteDto } from "@/lib/hub/contract";
import { NODE_COMMAND_COPY } from "@/lib/swap/copy";
import { FNN_DEFAULT_RPC_URL } from "@/lib/wallets/fiber-byo/constants";
import { fiberNetworkOf } from "@/lib/wallets/fiber-byo/network";
import { newInvoiceRequest } from "@/lib/wallets/fiber-byo/rpc-commands";
import { useHubFiberNode } from "../fiber-node/use-hub-fiber-node";
import { NodeCommand } from "./node-command";

/**
 * External node, BTC to a Fiber token: the new_invoice call that makes the payout invoice this quote needs. A token's
 * type script comes from the hub (GET /v1/fiber/node); until it is read, or when it cannot be, no command is shown and
 * the field's "?" still says what the invoice must ask for.
 */
export function OwnInvoiceCommand({ quote, network }: { quote: QuoteDto; network: string | null }) {
  const hub = useHubFiberNode(useHubClient());
  const asset = hub.node?.assets.find((a) => a.id === quote.asset);
  if (!asset) return null;
  const request = newInvoiceRequest({ amount: quote.receive.amount, network: fiberNetworkOf(network), udtTypeScript: asset.udtTypeScript });
  return (
    <NodeCommand
      label={NODE_COMMAND_COPY.INVOICE_LABEL}
      tip={NODE_COMMAND_COPY.INVOICE_TIP(FNN_DEFAULT_RPC_URL)}
      request={request}
      testId="swap-own-invoice-command"
    />
  );
}
