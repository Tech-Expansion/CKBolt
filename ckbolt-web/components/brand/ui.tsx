import type { ReactNode } from "react";
import { ArrowDownToLine, ArrowRight } from "lucide-react";
import { SiteLink } from "@/components/site-link";
import { cn } from "@/lib/utils";

/**
 * The pieces the brand pages (/brand, /brand-assets) share, in the site's patterns (docs/style-guide.md): the container,
 * the eyebrow, a section with its header, pill links and square download chips.
 */

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("max-w-[1400px] mx-auto px-6 lg:px-12", className)}>{children}</div>;
}

/** The mono label with a rule before it. `onInk` for the dark section. */
export function Eyebrow({ onInk = false, children }: { onInk?: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-3 text-sm font-mono",
        onInk ? "text-background/60" : "text-muted-foreground",
      )}
    >
      <span className={cn("w-8 h-px", onInk ? "bg-background/30" : "bg-foreground/30")} aria-hidden="true" />
      {children}
    </span>
  );
}

/** The page's H1, two short lines. */
export function BrandTitle({ children }: { children: ReactNode }) {
  return (
    <h1 className="text-[clamp(3.5rem,8vw,7rem)] font-display leading-[0.92] tracking-tight">{children}</h1>
  );
}

export function BrandLead({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p className={cn("text-[clamp(1.1875rem,1.7vw,1.5rem)] leading-relaxed text-muted-foreground", className)}>
      {children}
    </p>
  );
}

export type SectionTone = "paper" | "tint" | "ink";

const SECTION_TONE: Readonly<Record<SectionTone, string>> = {
  paper: "border-t border-foreground/10",
  tint: "border-t border-foreground/10 bg-foreground/[0.02]",
  ink: "bg-foreground text-background",
};

/** A full-width section: Paper, a faint tint, or Ink (one per page, for the process). */
export function BrandSection({
  id,
  tone = "paper",
  className,
  children,
}: {
  id?: string;
  tone?: SectionTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={cn("scroll-mt-24", SECTION_TONE[tone])}>
      <Container className={cn("py-24 lg:py-32 flex flex-col gap-12 lg:gap-14", className)}>{children}</Container>
    </section>
  );
}

/** A section's eyebrow and H2, with a lead or an action on the right. */
export function SectionHeader({
  eyebrow,
  title,
  lead,
  action,
  onInk = false,
}: {
  eyebrow: string;
  title: ReactNode;
  lead?: ReactNode;
  action?: ReactNode;
  onInk?: boolean;
}) {
  return (
    <div className="flex flex-wrap justify-between items-end gap-x-16 gap-y-8">
      <div className="flex-[999_1_520px] min-w-0 flex flex-col gap-6">
        <Eyebrow onInk={onInk}>{eyebrow}</Eyebrow>
        <h2 className="text-4xl lg:text-6xl font-display tracking-tight leading-none">{title}</h2>
      </div>
      {lead ? (
        <div className="flex-[1_1_360px] min-w-0">
          <p className={cn("max-w-[460px] text-lg leading-relaxed", onInk ? "text-background/60" : "text-muted-foreground")}>
            {lead}
          </p>
        </div>
      ) : null}
      {action}
    </div>
  );
}

type PillVariant = "ink" | "outline" | "paper" | "outline-on-ink";

const PILL_VARIANT: Readonly<Record<PillVariant, string>> = {
  ink: "bg-foreground text-background border border-foreground hover:bg-foreground/90",
  outline: "bg-background text-foreground border border-foreground/20 hover:bg-foreground/5",
  paper: "bg-background text-foreground hover:bg-background/90",
  "outline-on-ink": "text-background border border-background/30 hover:bg-background/10",
};

const PILL_SIZE = { lg: "h-14 px-7 text-base", md: "h-12 px-7 text-base" } as const;

/**
 * A pill link: a download (`download` set, a plain anchor that saves the file) or a page of the site (an arrow).
 * `srLabel` adds words for screen readers after the visible text.
 */
export function PillLink({
  href,
  download,
  variant = "ink",
  size = "lg",
  srLabel,
  children,
}: {
  href: string;
  download?: string;
  variant?: PillVariant;
  size?: keyof typeof PILL_SIZE;
  srLabel?: string;
  children: ReactNode;
}) {
  const className = cn(
    "inline-flex items-center gap-3 rounded-full whitespace-nowrap transition-colors group",
    PILL_SIZE[size],
    PILL_VARIANT[variant],
  );
  const extra = srLabel ? <span className="sr-only">{srLabel}</span> : null;
  if (download !== undefined) {
    return (
      <a href={href} download={download} className={className}>
        {children}
        {extra}
        <ArrowDownToLine className="w-4 h-4 transition-transform group-hover:translate-y-0.5" strokeWidth={1.5} aria-hidden="true" />
      </a>
    );
  }
  return (
    <SiteLink href={href} className={className}>
      {children}
      {extra}
      <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" strokeWidth={1.5} aria-hidden="true" />
    </SiteLink>
  );
}

/** A square chip that downloads one file: the visible label ("SVG · 4 KB"), then the file's name for screen readers. */
export function DownloadChip({ href, label, fileName }: { href: string; label: string; fileName: string }) {
  return (
    <a
      href={href}
      download={fileName}
      className="inline-flex items-center gap-2 px-3 py-1.5 border border-foreground/10 bg-card font-mono text-[13px] text-foreground hover:border-foreground/30 transition-colors"
    >
      {label}
      <span className="sr-only">, download {fileName}</span>
      <ArrowDownToLine className="w-3 h-3" strokeWidth={1.5} aria-hidden="true" />
    </a>
  );
}

/** A square mono tag (not a link). */
export function BrandTag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 px-3 py-1.5 border border-foreground/10 bg-card font-mono text-[13px] text-foreground">
      {children}
    </span>
  );
}

/** The hatch behind the hero figure and the kit panel: a 1px Ink line at 6% every 41px. */
export const HATCH_BACKGROUND =
  "bg-card bg-[repeating-linear-gradient(-45deg,transparent_0,transparent_40px,rgb(8_5_3/0.06)_40px,rgb(8_5_3/0.06)_41px)]";
