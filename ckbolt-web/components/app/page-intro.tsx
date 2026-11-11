import type { ReactNode } from "react";
import { InfoTip } from "./swap/info-tip";

/** Detail that does not fit the lead's one line, behind a "?" at its end. */
export interface PageIntroTip {
  /** Names what the tip explains ("About the browser node"), for screen readers and tests. */
  label: string;
  text: ReactNode;
}

/**
 * An app page's eyebrow, H1 and one short lead line (docs/live-swap-ui.md, Goals 3): anything longer goes in `tip`.
 * Used by /app, /app/fiber and /app/fiber/fund.
 */
export function PageIntro({ eyebrow, heading, lead, tip }: { eyebrow: string; heading: string; lead: string; tip?: PageIntroTip }) {
  return (
    <>
      <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground mb-6">
        <span className="w-8 h-px bg-foreground/30" />
        {eyebrow}
      </span>
      <h1 className="text-4xl lg:text-6xl font-display tracking-tight mb-6">{heading}</h1>
      <p className="text-xl text-muted-foreground leading-relaxed max-w-2xl mb-12 lg:mb-16">
        {lead}
        {tip ? (
          <>
            {" "}
            <InfoTip label={tip.label} align="start">
              {tip.text}
            </InfoTip>
          </>
        ) : null}
      </p>
    </>
  );
}
