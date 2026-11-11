import type { HTMLAttributes, ReactNode } from "react";
import { CircleAlert, CircleCheck, Clock, Info, type LucideIcon } from "lucide-react";
import type { StatusTone } from "@/lib/status-tone";
import { cn } from "@/lib/utils";

/**
 * The status colours in three shapes, used for every state of the app (docs/style-guide.md, Colour): a dot, a badge and
 * a notice. Each one only colours a state that is also said in words next to it; the dot is decorative.
 */

/** A pending dot pulses gently, unless the visitor reduced motion or paused it on this site (lib/motion.ts). */
const PULSE = "motion-safe:animate-pulse [html[data-motion=paused]_&]:animate-none";

const DOT: Readonly<Record<StatusTone, string>> = {
  ok: "bg-fiber-bright ring-4 ring-fiber-bright/20",
  pending: cn("bg-pending-bright", PULSE),
  error: "bg-destructive",
  off: "bg-foreground/30",
};

export function StatusDot({ tone, className }: { tone: StatusTone; className?: string }) {
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", DOT[tone], className)} aria-hidden="true" />;
}

/** A 2px rule on the left of a row (a channel, an entry) in the state's bright colour. */
const RULE: Readonly<Record<StatusTone, string>> = {
  ok: "border-l-fiber-bright",
  pending: "border-l-pending-bright",
  error: "border-l-destructive",
  off: "border-l-foreground/30",
};
export const statusRule = (tone: StatusTone): string => cn("border-l-2", RULE[tone]);

const BADGE: Readonly<Record<StatusTone, string>> = {
  ok: "border-fiber/25 bg-fiber-soft text-fiber",
  pending: "border-pending/25 bg-pending-soft text-pending",
  error: "border-destructive/40 bg-background text-destructive",
  off: "border-foreground/15 text-muted-foreground",
};

/** The badge's border, fill and text colours, for another square that carries a state (a result's mark). */
export const statusTint = (tone: StatusTone): string => cn("border", BADGE[tone]);

/** A square mono tag in the state's colour (off is the plain neutral tag); `dot` puts the state's dot before the words. */
export function StatusBadge({ tone, children, dot = false, className, ...props }: { tone: StatusTone; dot?: boolean } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap border px-2 py-0.5 font-mono text-xs", BADGE[tone], className)} {...props}>
      {dot && <StatusDot tone={tone} className="ring-0" />}
      {children}
    </span>
  );
}

const NOTICE: Readonly<Record<StatusTone, { box: string; icon: LucideIcon; iconClass: string }>> = {
  ok: { box: "bg-fiber-soft border-fiber-bright", icon: CircleCheck, iconClass: "text-fiber" },
  pending: { box: "bg-pending-soft border-pending-bright", icon: Clock, iconClass: "text-pending" },
  // Red on this tint is under 4.5:1, so the words stay foreground; red goes to the border and the icon.
  error: { box: "bg-destructive-soft border-destructive", icon: CircleAlert, iconClass: "text-destructive" },
  off: { box: "bg-foreground/[0.03] border-foreground/30", icon: Info, iconClass: "text-muted-foreground" },
};

/** A line or two about a state, on the state's tint with a 2px left rule and its icon; the words stay foreground. */
export function StatusNotice({ tone, children, className, ...props }: { tone: StatusTone; children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  const { box, icon: Icon, iconClass } = NOTICE[tone];
  return (
    <div className={cn("flex items-start gap-2 border-l-2 px-3 py-2 text-sm text-foreground", box, className)} {...props}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", iconClass)} aria-hidden="true" />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}
