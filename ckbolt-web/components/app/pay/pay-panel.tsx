"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useSharedHubStatus } from "@/hooks/use-hub-status";
import { classifyPayInput, type PayTarget } from "@/lib/pay/classify";
import { PAY_COPY } from "@/lib/pay/copy";
import { BROWSER_NODE_NETWORK } from "@/lib/wallets/fiber-browser/constants";
import { StatusBadge } from "../status";
import { useClock } from "../swap/quote-timer";
import { useFiberWalletController } from "../swap/wallets/use-fiber-wallet-controller";
import { FiberPay } from "./fiber-pay";
import { LightningPay } from "./lightning-pay";
import { OnChainPay } from "./on-chain-pay";
import { PayField } from "./pay-field";
import { NodeNeeded, nodeRunning, PayError, type PayFlowProps } from "./pay-parts";

/**
 * Pay (docs/pay-get-paid.md, part B), with a live hub: one field for what to pay, pasted or scanned. A Lightning invoice
 * is a CKB or a token to BTC swap, exact out; a Fiber invoice the browser node pays directly; a CKB address gets CKB on
 * chain from the node. Each needs the browser Fiber node, and the node asks the visitor to confirm what is not a swap
 * in the node itself. While a payment runs the field is read-only and keeps what was paid.
 */
export function PayPanel({ active }: { active: boolean }) {
  // What runs keeps the target it started with: an invoice expiring meanwhile must not take the payment's view away.
  const [held, setHeld] = useState<PayTarget | null>(null);
  const locked = held !== null;
  // A payment keeps the hub status it started with, as a swap does.
  const hub = useSharedHubStatus(true, locked);
  const nowMs = useClock();
  const titleId = useId();
  const errorId = useId();
  const [text, setText] = useState("");
  const controller = useFiberWalletController(hub.health?.fiber.network ?? null, false, { fixedKind: "browser-node", active: active || locked });
  const { presence, checking } = controller.node.view;

  const read = useMemo(
    () => classifyPayInput(text, { lightningNetwork: hub.health?.lightning.network ?? null, fiberNetwork: BROWSER_NODE_NETWORK, nowMs }),
    [text, hub.health?.lightning.network, nowMs],
  );
  const target = held ?? read;
  const latestRead = useRef(read);
  useEffect(() => {
    latestRead.current = read;
  });
  const onLock = useCallback((on: boolean) => setHeld((h) => (on ? (h ?? latestRead.current) : null)), []);
  const onDone = useCallback(() => {
    setHeld(null);
    setText("");
  }, []);

  const flow: PayFlowProps = { fiber: controller.api, presence, client: controller.client, nowMs, onLock, onDone };
  const invalid = target.kind === "invalid";

  return (
    <section aria-labelledby={titleId} className="mx-auto w-full max-w-[480px] border border-foreground/10 bg-background" data-testid="pay-card">
      <header className="flex items-center justify-between gap-3 border-b border-foreground/10 px-4 py-3 sm:px-5">
        <h2 id={titleId} className="font-display text-2xl">
          {PAY_COPY.TITLE}
        </h2>
        <StatusBadge tone="pending">{PAY_COPY.NETWORK_TAG}</StatusBadge>
      </header>
      <div className="space-y-4 p-4 sm:p-5">
        <PayField value={text} onChange={setText} invalid={invalid} locked={locked} describedBy={invalid ? errorId : undefined} />
        {target.kind !== "empty" && target.kind !== "invalid" && (
          <p className="font-mono text-xs text-foreground/70" data-testid="pay-kind" data-kind={target.kind}>
            {PAY_COPY.KIND[target.kind]}
          </p>
        )}
        {target.kind === "empty" && !checking && !nodeRunning(presence) && <NodeNeeded />}
        {target.kind === "invalid" && (
          <div id={errorId}>
            <PayError error={target.error} />
          </div>
        )}
        {target.kind === "lightning" && <LightningPay key={target.invoice.invoice} invoice={target.invoice} hub={hub} {...flow} />}
        {target.kind === "fiber" && <FiberPay key={target.invoice} invoice={target.invoice} assets={hub.assets} {...flow} />}
        {target.kind === "ckb-address" && <OnChainPay key={target.address} address={target.address} {...flow} />}
      </div>
    </section>
  );
}
