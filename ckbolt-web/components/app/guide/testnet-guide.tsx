"use client";

import { ArrowUpRight } from "lucide-react";
import { SiteLink } from "@/components/site-link";
import { FeedbackLink } from "../feedback-link";
import { WALLET_ACTION } from "../swap/wallets/copy";
import { CopyButton, Panel } from "../ui";
import { GUIDE_HELP_LINE, GUIDE_LIMITS, GUIDE_NEEDS, GUIDE_STEPS, GUIDE_TITLE, type GuideCode, type GuideLink, type GuideStep } from "./copy";

/**
 * The testnet guide's body (docs/style-guide.md, App UI patterns): the steps on the left; what you need, the limits and
 * where to report a problem on the right. On a phone the panels stack in their numbered order.
 */
export function TestnetGuide() {
  return (
    // minmax(0, 1fr) and min-w-0: a long command scrolls inside its block instead of widening the page on a phone.
    <div
      className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_420px] lg:grid-rows-[auto_1fr] gap-6 lg:gap-x-10 items-start"
      data-testid="testnet-guide"
    >
      <div className="min-w-0 lg:col-start-2 lg:row-start-1">
        <Panel step="01" title={GUIDE_TITLE.NEEDS}>
          <Lines lines={GUIDE_NEEDS} testId="testnet-guide-needs" />
        </Panel>
      </div>
      <div className="min-w-0 lg:col-start-1 lg:row-start-1 lg:row-span-2">
        <Panel step="02" title={GUIDE_TITLE.STEPS}>
          <ol className="space-y-0" data-testid="testnet-guide-steps">
            {GUIDE_STEPS.map((step, i) => (
              <StepItem key={step.title} step={step} number={i + 1} last={i === GUIDE_STEPS.length - 1} />
            ))}
          </ol>
        </Panel>
      </div>
      <div className="min-w-0 space-y-6 lg:col-start-2 lg:row-start-2">
        <Panel step="03" title={GUIDE_TITLE.LIMITS}>
          <Lines lines={GUIDE_LIMITS} testId="testnet-guide-limits" />
        </Panel>
        <Panel step="04" title={GUIDE_TITLE.HELP}>
          <p className="text-sm text-muted-foreground">{GUIDE_HELP_LINE}</p>
          <FeedbackLink testId="testnet-guide-report" />
        </Panel>
      </div>
    </div>
  );
}

/** One step: a square numbered marker on a hairline rail (as in How it works), its lines, a block to copy, links. */
function StepItem({ step, number, last }: { step: GuideStep; number: number; last: boolean }) {
  const [first, ...rest] = step.lines;
  return (
    <li className="relative flex gap-4 pb-8 last:pb-0">
      {!last && <span aria-hidden="true" className="absolute left-3.5 top-7 bottom-0 w-px bg-foreground/15" />}
      <span
        aria-hidden="true"
        className="relative flex h-7 w-7 shrink-0 items-center justify-center border border-foreground/15 bg-background font-mono text-xs tabular-nums"
      >
        {String(number).padStart(2, "0")}
      </span>
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        <h3 className="text-base font-medium leading-tight">{step.title}</h3>
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          <li>{first}</li>
          {step.code && (
            <li>
              <CodeBlock code={step.code} />
            </li>
          )}
          {rest.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {step.links && (
          <p className="flex flex-wrap gap-x-5">
            {step.links.map((link) => (
              <StepLink key={link.label} link={link} />
            ))}
          </p>
        )}
      </div>
    </li>
  );
}

/** A command or address in a block that scrolls sideways on a phone, with its Copy button. */
function CodeBlock({ code }: { code: GuideCode }) {
  return (
    <div className="my-1">
      <pre
        role="region"
        aria-label={code.label}
        tabIndex={0}
        className="overflow-x-auto border border-foreground/10 bg-foreground/[0.03] p-3 font-mono text-xs text-foreground"
      >
        {code.text}
      </pre>
      <CopyButton value={code.text} label={code.copy} />
    </div>
  );
}

/** A link of a step; other sites open in a new tab. The site's pages move client-side, so the Fiber node keeps running. */
function StepLink({ link }: { link: GuideLink }) {
  return (
    <SiteLink
      href={link.href}
      {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="inline-flex min-h-10 items-center gap-1 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      {link.label}
      <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
      {link.external && <span className="sr-only"> {WALLET_ACTION.NEW_TAB}</span>}
    </SiteLink>
  );
}

function Lines({ lines, testId }: { lines: readonly string[]; testId: string }) {
  return (
    <ul className="space-y-2 text-sm" data-testid={testId}>
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}
