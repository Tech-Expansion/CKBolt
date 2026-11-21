import type { CSSProperties } from "react";
import {
  LOCKUP_VIEW_BOX,
  LOCKUP_WORDMARK,
  LOCKUP_WORDMARK_TRANSFORM,
  MARK_FOLDS,
  MARK_OUTLINE,
  MARK_TRANSFORM,
  MARK_VIEW_BOX,
} from "./logo-paths";

/** The kit's outline stroke: the mark is filled and stroked in one color, which rounds its corners. */
const OUTLINE_STROKE_WIDTH = 14;

/** Folds on an Ink mark (white at 24%) and on a reversed one (black at 20%), as in the kit's files. */
const FOLDS_ON_INK = { fill: "#FFFFFF", fillOpacity: 0.24 } as const;
const FOLDS_ON_PAPER = { fill: "#000000", fillOpacity: 0.2 } as const;

function MarkShapes({ reversed }: { reversed: boolean }) {
  const folds = reversed ? FOLDS_ON_PAPER : FOLDS_ON_INK;
  return (
    <g transform={MARK_TRANSFORM}>
      <path
        d={MARK_OUTLINE}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={OUTLINE_STROKE_WIDTH}
        strokeLinejoin="round"
      />
      {MARK_FOLDS.map((d) => (
        <path key={d} d={d} {...folds} />
      ))}
    </g>
  );
}

/**
 * The CKBolt mark, drawn in the current text color: Ink on Paper, or Paper on Ink with `reversed`. Decorative unless
 * it has a `title` (then it is an image with that name).
 */
export function BrandMark({
  className,
  reversed = false,
  title,
}: {
  className?: string;
  reversed?: boolean;
  title?: string;
}) {
  return (
    <svg
      viewBox={MARK_VIEW_BOX}
      className={className}
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}
      focusable="false"
    >
      <MarkShapes reversed={reversed} />
    </svg>
  );
}

/**
 * The horizontal lockup (mark and outlined wordmark) in the current text color. Only the brand guidelines draw it
 * inline, to show what not to do with it; everywhere else uses the kit's files.
 */
export function BrandLockup({
  className,
  style,
  title,
}: {
  className?: string;
  style?: CSSProperties;
  title: string;
}) {
  return (
    <svg viewBox={LOCKUP_VIEW_BOX} className={className} style={style} role="img" aria-label={title} focusable="false">
      <g transform="translate(64 52)">
        <MarkShapes reversed={false} />
      </g>
      <path transform={LOCKUP_WORDMARK_TRANSFORM} d={LOCKUP_WORDMARK} fill="currentColor" />
    </svg>
  );
}
