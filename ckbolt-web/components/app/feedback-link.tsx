import { ArrowUpRight } from "lucide-react";
import { FEEDBACK_COPY, feedbackUrl } from "@/lib/feedback";
import { cn } from "@/lib/utils";
import { WALLET_ACTION } from "./swap/wallets/copy";

/** "Report a problem", in a new tab: an issue form with the swap id filled in when there is one (lib/feedback.ts). */
export function FeedbackLink({ swapId = null, className, testId }: { swapId?: string | null; className?: string; testId?: string }) {
  return (
    <a
      href={feedbackUrl(swapId)}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex min-h-10 items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2",
        className,
      )}
      data-testid={testId}
    >
      {FEEDBACK_COPY.LINK}
      <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="sr-only"> {WALLET_ACTION.NEW_TAB}</span>
    </a>
  );
}
