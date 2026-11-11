"use client";

import { useEffect, useState } from "react";
import { SWAP_CARD } from "@/lib/swap/constants";
import { DETAILS_COPY } from "@/lib/swap/copy";

/** The page's clock for the card: the quote countdown and the run's expiry checks. */
export function useClock(tickMs: number = SWAP_CARD.clockTickMs): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return now;
}

const RING = { size: 16, radius: 6, stroke: 2 } as const;
const CIRCUMFERENCE = 2 * Math.PI * RING.radius;

/** "◔ 24s": the quote's time left, the ring emptying as it runs out. A timer role, so it is not read out every second. */
export function QuoteTimer({ secondsLeft, totalSeconds, testId = "swap-quote-timer" }: { secondsLeft: number; totalSeconds: number; testId?: string }) {
  const expired = secondsLeft <= 0;
  const fraction = totalSeconds > 0 ? Math.min(1, secondsLeft / totalSeconds) : 0;
  const centre = RING.size / 2;
  return (
    <span
      role="timer"
      aria-label={expired ? DETAILS_COPY.TIMER_EXPIRED_LABEL : DETAILS_COPY.TIMER_LABEL(secondsLeft)}
      className={`inline-flex items-center gap-1.5 tabular-nums ${expired ? "text-destructive" : ""}`}
      data-testid={testId}
    >
      <svg viewBox={`0 0 ${RING.size} ${RING.size}`} className="h-3.5 w-3.5 -rotate-90" aria-hidden="true">
        <circle cx={centre} cy={centre} r={RING.radius} fill="none" strokeWidth={RING.stroke} className="stroke-foreground/15" />
        <circle
          cx={centre}
          cy={centre}
          r={RING.radius}
          fill="none"
          strokeWidth={RING.stroke}
          strokeDasharray={`${fraction * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
          className="stroke-current"
        />
      </svg>
      {expired ? DETAILS_COPY.EXPIRED : `${secondsLeft}s`}
    </span>
  );
}
