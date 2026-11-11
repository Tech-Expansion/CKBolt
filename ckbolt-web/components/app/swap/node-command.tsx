"use client";

import { NODE_COMMAND_COPY } from "@/lib/swap/copy";
import { curlCommand, type FnnRequest } from "@/lib/wallets/fiber-byo/rpc-commands";
import { CopyButton } from "../ui";

/**
 * Text an external node's owner copies into a terminal or a config (an fnn command, a whitelist entry), behind a
 * disclosure, with what it does and Copy. The text wraps inside the card, so nothing is wider than a phone.
 */
export function CopyableBlock({ label, tip, text, copyLabel, testId }: { label: string; tip: string; text: string; copyLabel: string; testId: string }) {
  return (
    <details className="group mt-3 border-t border-foreground/10 pt-2" data-testid={testId}>
      <summary className="flex min-h-10 cursor-pointer items-center text-sm font-medium" data-testid={`${testId}-toggle`}>
        {label}
      </summary>
      <p className="text-xs text-muted-foreground">{tip}</p>
      <pre
        className="mt-2 whitespace-pre-wrap break-all border border-foreground/10 bg-foreground/[0.03] p-3 font-mono text-[11px] leading-relaxed"
        data-testid={`${testId}-text`}
      >
        {text}
      </pre>
      <CopyButton value={text} label={copyLabel} testId={`${testId}-copy`} />
    </details>
  );
}

/** One fnn JSON-RPC call as a curl line (lib/wallets/fiber-byo/rpc-commands.ts). */
export function NodeCommand({ label, tip, request, testId }: { label: string; tip: string; request: FnnRequest; testId: string }) {
  return <CopyableBlock label={label} tip={tip} text={curlCommand(request)} copyLabel={NODE_COMMAND_COPY.COPY} testId={testId} />;
}
