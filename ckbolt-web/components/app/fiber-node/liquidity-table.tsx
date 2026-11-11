import { cn } from "@/lib/utils";
import type { LiquidityRow } from "@/lib/wallets/fiber-wallet/liquidity";
import { LIQUIDITY_COPY } from "./copy";

/** A zero reads muted, so what the node can move stands out; the numbers stay neutral. */
const amountCell = (amount: string): string =>
  cn("py-1 text-right font-mono text-xs [overflow-wrap:anywhere]", amount === ZERO && "text-muted-foreground");
const ZERO = "0";

/** What the node can send and receive now, one row per token: the swap card's Fiber dialog and the wallet's Home. */
export function LiquidityTable({ rows, testId = "fiber-node-liquidity" }: { rows: readonly LiquidityRow[]; testId?: string }) {
  return (
    <table className="w-full text-sm tabular-nums" aria-label={LIQUIDITY_COPY.LABEL} data-testid={testId}>
      <thead>
        <tr className="font-mono text-xs text-muted-foreground">
          <th scope="col" className="py-1 text-left font-normal">
            <span className="sr-only">{LIQUIDITY_COPY.ASSET}</span>
          </th>
          <th scope="col" className="py-1 text-right font-normal">
            {LIQUIDITY_COPY.SEND}
          </th>
          <th scope="col" className="py-1 text-right font-normal">
            {LIQUIDITY_COPY.RECEIVE}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-t border-foreground/5">
            <th scope="row" className="py-1 text-left font-mono text-xs font-normal">
              {row.symbol}
            </th>
            <td className={amountCell(row.send)}>{row.send}</td>
            <td className={amountCell(row.receive)}>{row.receive}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
