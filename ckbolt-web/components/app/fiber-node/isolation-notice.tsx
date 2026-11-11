"use client";

import type { IsolationReport } from "@/lib/wallets/fiber-browser/isolation";
import { DIP_MIN_CHROMIUM_VERSION } from "@/lib/wallets/fiber-browser/constants";
import { InfoTip } from "../swap/info-tip";
import { StatusBadge } from "../status";
import { Panel, primaryButton } from "../ui";

/** Why the node cannot run on this page, and what to try. */
export function IsolationNotice({ report }: { report: IsolationReport }) {
  return (
    <Panel step="01" title="This browser cannot run the node here" aside={<StatusBadge tone="error">Not available</StatusBadge>}>
      <div className="space-y-4" role="alert" data-testid="fiber-node-isolation">
        <p className="text-muted-foreground leading-relaxed">
          The node needs shared memory, which this page lacks.{" "}
          <InfoTip label="Why the node cannot run" align="start">
            A Fiber node in the browser needs shared memory, which browsers give only to a cross-origin-isolated page on HTTPS or
            localhost.
          </InfoTip>
        </p>
        <ul className="text-sm space-y-1">
          {!report.secureContext && <li>The page is not on HTTPS or localhost.</li>}
          {!report.isolated && <li>The page is not cross-origin isolated.</li>}
          {!report.sharedMemory && <li>SharedArrayBuffer is not available.</li>}
        </ul>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Try Chrome or Edge {DIP_MIN_CHROMIUM_VERSION}+, or Firefox.{" "}
          <InfoTip label="Which browsers work" align="start">
            Use a recent Chrome or Edge (version {DIP_MIN_CHROMIUM_VERSION} or later) or Firefox, and open this page directly rather than
            inside another site. Safari may refuse it.
          </InfoTip>
        </p>
        <button type="button" onClick={() => window.location.reload()} className={primaryButton}>
          Reload the page
        </button>
      </div>
    </Panel>
  );
}

/** What the visitor should know before trusting the browser node with test funds. */
export function NodeLimits() {
  return (
    <section className="border border-foreground/10 p-6 space-y-3" data-testid="fiber-node-limits">
      <p className="font-mono text-xs text-muted-foreground">
        Before you fund it{" "}
        <InfoTip label="About the limits" align="start">
          A full Fiber node runs inside this tab. A closed tab cannot receive a payout or finish a payment. Clearing site data or a private
          window loses the channels. No watchtower watches a browser node, so close channels cooperatively from this page.
        </InfoTip>
      </p>
      <ul className="text-sm text-muted-foreground leading-relaxed space-y-2 list-disc pl-5">
        <li>Testnet only, and experimental.</li>
        <li>Keep this tab open while a swap runs.</li>
        <li>Channels live in this browser: close them before clearing data.</li>
        <li>No watchtower: close channels from this page.</li>
        <li>Only one tab runs the node at a time.</li>
      </ul>
    </section>
  );
}
