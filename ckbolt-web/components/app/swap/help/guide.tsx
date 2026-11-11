import { useId, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { SiteLink } from "@/components/site-link";
import { FIBER_ASSETS_FALLBACK } from "@/lib/hub/assets";
import { GUIDE_HUB_HREF, GUIDE_PAGE_PATH } from "../../guide/constants";
import {
  HOW_IT_WORKS_GUIDE_LINK,
  HOW_IT_WORKS_HEADING,
  HOW_IT_WORKS_HUB_LINK,
  HOW_IT_WORKS_L1_NOTE,
  HOW_IT_WORKS_ONE_CLICK,
  HOW_IT_WORKS_SAFETY,
  HOW_IT_WORKS_STEPS,
  HOW_IT_WORKS_TESTNET,
  howItWorksWallets,
} from "./copy";
import { StepsDiagram } from "./steps-diagram";

/**
 * The body of the "How it works" dialog: four short sections (the steps, the wallets, safety, test networks), then
 * links to the testnet guide and to its card with the hub's addresses. `assets` are the symbols the hub serves.
 */
export function HowItWorksGuide({ assets = [] }: { assets?: readonly string[] } = {}) {
  return (
    <div className="space-y-6" data-testid="how-it-works-guide">
      <Section heading={HOW_IT_WORKS_HEADING.STEPS}>
        <StepsDiagram steps={HOW_IT_WORKS_STEPS} />
        <p className="mt-4 text-sm">{HOW_IT_WORKS_ONE_CLICK}</p>
      </Section>

      <Section heading={HOW_IT_WORKS_HEADING.WALLETS}>
        <dl className="text-sm">
          {howItWorksWallets(assets.length > 0 ? assets.join(", ") : FIBER_ASSETS_FALLBACK).map((w) => (
            <div key={w.network} className="flex flex-col gap-0.5 py-2 border-b border-foreground/5 last:border-b-0">
              <dt className="font-medium">
                {w.network} <span className="font-mono text-xs text-muted-foreground">{w.assets}</span>
              </dt>
              <dd className="text-muted-foreground">{w.text}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-sm text-muted-foreground">{HOW_IT_WORKS_L1_NOTE}</p>
      </Section>

      <Section heading={HOW_IT_WORKS_HEADING.SAFETY}>
        <Lines lines={HOW_IT_WORKS_SAFETY} />
      </Section>

      <Section heading={HOW_IT_WORKS_HEADING.TESTNET}>
        <Lines lines={HOW_IT_WORKS_TESTNET} />
      </Section>

      <p className="flex flex-wrap gap-x-6">
        <SiteLink href={GUIDE_PAGE_PATH} className={linkClass} data-testid="how-it-works-guide-link">
          {HOW_IT_WORKS_GUIDE_LINK}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </SiteLink>
        <SiteLink href={GUIDE_HUB_HREF} className={linkClass} data-testid="how-it-works-hub-link">
          {HOW_IT_WORKS_HUB_LINK}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </SiteLink>
      </p>
    </div>
  );
}

const linkClass =
  "inline-flex min-h-10 items-center gap-2 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2";

/** One section: a mono heading and its content, named by the heading. */
function Section({ heading, children }: { heading: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="mb-3 font-mono text-xs text-muted-foreground">
        {heading}
      </h3>
      {children}
    </section>
  );
}

function Lines({ lines }: { lines: readonly string[] }) {
  return (
    <ul className="space-y-1.5 text-sm">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}
