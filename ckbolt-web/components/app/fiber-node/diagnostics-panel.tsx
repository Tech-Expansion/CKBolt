"use client";

import { useState, type FormEvent } from "react";
import { formatUnits } from "@/lib/hub/format";
import { formatAssetUnits } from "@/lib/wallets/fiber-browser/tokens";
import type { FiberNetwork } from "@/lib/payment-request";
import {
  buildDiagnostics,
  checkRoute,
  diagnosticsJson,
  type DiagnosticsAsset,
  type KnownAsset,
  type RouteCheckReport,
} from "@/lib/wallets/fiber-browser/diagnostics";
import { fiberErrorMessage } from "@/lib/wallets/fiber-browser/errors";
import type { BrowserFiberNode } from "@/lib/wallets/fiber-browser/node-port";
import { CKB_DECIMALS, FIBER_JS_VERSION } from "@/lib/wallets/fiber-browser/constants";
import { StatusDot, StatusNotice } from "../status";
import { Panel } from "../ui";
import { DIAGNOSTICS_COPY } from "./copy";
import { TextField } from "./fields";
import { pillButton } from "./styles";

type CopyState = { kind: "idle" } | { kind: "reading" } | { kind: "copied" } | { kind: "blocked" } | { kind: "failed"; error: string };

interface DiagnosticsPanelProps {
  node: BrowserFiberNode;
  network: FiberNetwork;
  /**
   * The hub's live node id on this network, as Pay uses it, or null: never one kept from before, so Check a route does not
   * probe a hub that is gone (it says the dry run through the hub was skipped).
   */
  hubNodeId: string | null;
  /** Every id the hub is known by, kept ones included: they only mark a channel `withHub` in the JSON. */
  hubNodeIds: readonly string[];
  assets: readonly KnownAsset[];
  /** A token's decimals as the hub lists them, or null when it does not (its amounts then show as base units). */
  decimalsOf: (asset: string) => number | null;
  symbolOf: (asset: string) => string;
}

/**
 * Panel 06, while the node runs: Copy diagnostics (node_info and list_channels as JSON, lib/wallets/fiber-browser/
 * diagnostics.ts) and Check a route (send_payment dry runs of a pasted invoice, directly and through the hub). Nothing
 * here pays or writes History.
 */
export function DiagnosticsPanel({ node, network, hubNodeId, hubNodeIds, assets, decimalsOf, symbolOf }: DiagnosticsPanelProps) {
  const [copy, setCopy] = useState<CopyState>({ kind: "idle" });
  const [json, setJson] = useState<string | null>(null);
  const [invoice, setInvoice] = useState("");
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<RouteCheckReport | null>(null);

  const copyDiagnostics = async () => {
    setCopy({ kind: "reading" });
    let text: string;
    try {
      if (!node.readDiagnostics) throw new Error(DIAGNOSTICS_COPY.NOT_SUPPORTED);
      const raw = await node.readDiagnostics();
      text = diagnosticsJson(
        buildDiagnostics({ raw, generatedAt: new Date(), network, fiberJsVersion: FIBER_JS_VERSION, hubNodeId, hubNodeIds, assets, routeCheck: report }),
      );
    } catch (e) {
      setCopy({ kind: "failed", error: fiberErrorMessage(e) });
      return;
    }
    setJson(text);
    try {
      await navigator.clipboard.writeText(text);
      setCopy({ kind: "copied" });
    } catch {
      setCopy({ kind: "blocked" });
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (checking) return;
    setChecking(true);
    try {
      setReport(await checkRoute(node, invoice, { network, hubNodeId, assets, now: new Date() }));
    } finally {
      setChecking(false);
    }
  };

  const amountText = (amount: string, asset: DiagnosticsAsset | null) => {
    if (asset === null || asset.kind === "CKB") return `${formatUnits(amount, CKB_DECIMALS)} CKB`;
    // A token the hub lists, by its symbol and decimals; one it does not list, in base units.
    return asset.name === null ? formatAssetUnits(amount, null, "UDT") : formatAssetUnits(amount, decimalsOf(asset.name), symbolOf(asset.name));
  };
  const inputError = report?.error && report.checks.length === 0 ? report.error : null;

  return (
    <Panel step="06" title={DIAGNOSTICS_COPY.TITLE}>
      <div className="space-y-6" data-testid="fiber-node-diagnostics">
        <p className="text-sm text-muted-foreground leading-relaxed">{DIAGNOSTICS_COPY.LEAD}</p>
        <div className="space-y-3">
          <button type="button" className={pillButton} onClick={() => void copyDiagnostics()} disabled={copy.kind === "reading"} data-testid="diagnostics-copy">
            {copy.kind === "reading" ? DIAGNOSTICS_COPY.READING : DIAGNOSTICS_COPY.COPY}
          </button>
          <div aria-live="polite" data-testid="diagnostics-copy-status">
            {copy.kind === "copied" && <StatusNotice tone="ok">{DIAGNOSTICS_COPY.COPIED}</StatusNotice>}
            {copy.kind === "blocked" && <StatusNotice tone="pending">{DIAGNOSTICS_COPY.COPY_BLOCKED}</StatusNotice>}
            {copy.kind === "failed" && <StatusNotice tone="error">{DIAGNOSTICS_COPY.READ_FAILED(copy.error)}</StatusNotice>}
          </div>
          {json && (
            <pre
              role="region"
              aria-label={DIAGNOSTICS_COPY.JSON_LABEL}
              tabIndex={0}
              className="max-h-64 overflow-auto border border-foreground/10 bg-foreground/[0.02] p-3 font-mono text-xs leading-relaxed whitespace-pre"
              data-testid="diagnostics-json"
            >
              {json}
            </pre>
          )}
        </div>
        <form onSubmit={(e) => void submit(e)} className="space-y-3 border-t border-foreground/10 pt-6" data-testid="diagnostics-route-form">
          <TextField
            label={DIAGNOSTICS_COPY.ROUTE_LABEL}
            value={invoice}
            onChange={setInvoice}
            placeholder={DIAGNOSTICS_COPY.ROUTE_PLACEHOLDER}
            hint={DIAGNOSTICS_COPY.ROUTE_HINT}
            error={inputError}
            testId="diagnostics-route-input"
          />
          <button type="submit" className={pillButton} disabled={checking || !invoice.trim()} data-testid="diagnostics-route-submit">
            {checking ? DIAGNOSTICS_COPY.ROUTE_CHECKING : DIAGNOSTICS_COPY.ROUTE_SUBMIT}
          </button>
        </form>
        <div aria-live="polite">
          {report && report.checks.length > 0 && (
            <div className="space-y-2" data-testid="diagnostics-route">
              <h3 className="text-sm text-muted-foreground">{DIAGNOSTICS_COPY.ROUTE_RESULTS}</h3>
              <ul>
                {report.checks.map((c) => (
                  <li
                    key={c.via}
                    className="flex items-start gap-3 py-3 border-b border-foreground/5 last:border-b-0 text-sm"
                    data-testid="diagnostics-route-check"
                    data-via={c.via}
                    data-ok={c.ok ? "true" : "false"}
                  >
                    <StatusDot tone={c.ok ? "ok" : "error"} className="mt-1.5 shrink-0" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      <span className="font-medium">{DIAGNOSTICS_COPY.VIA[c.via]}: </span>
                      {c.ok ? DIAGNOSTICS_COPY.ROUTE_OK(amountText(c.fee ?? "0", report.target.asset)) : DIAGNOSTICS_COPY.ROUTE_FAILED(c.error ?? "")}
                    </span>
                  </li>
                ))}
                {report.trampolineSkipped && (
                  <li
                    className="flex items-start gap-3 py-3 border-b border-foreground/5 last:border-b-0 text-sm"
                    data-testid="diagnostics-route-skipped"
                    data-reason={report.trampolineSkipped}
                  >
                    <StatusDot tone="off" className="mt-1.5 shrink-0" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      <span className="font-medium">{DIAGNOSTICS_COPY.VIA.trampoline}: </span>
                      {DIAGNOSTICS_COPY.ROUTE_SKIPPED[report.trampolineSkipped]}
                    </span>
                  </li>
                )}
              </ul>
              <p className="text-xs text-muted-foreground">{DIAGNOSTICS_COPY.ROUTE_IN_JSON}</p>
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
