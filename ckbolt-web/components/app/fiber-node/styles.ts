/** Class names of the node page and the swap form's node controls (style guide: App UI patterns). */

/** Pill button (h-10), as on the swap form. */
export const pillButton =
  "inline-flex items-center justify-center border border-foreground/20 rounded-full px-4 h-10 text-sm hover:bg-foreground/5 disabled:opacity-40 disabled:cursor-not-allowed";

/** Text button for secondary actions. */
export const textButton = "min-h-10 px-3 -mx-3 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed";

/** Square text input. */
export const textInput =
  "w-full h-11 border border-foreground/15 bg-background px-3 font-mono text-xs focus:outline-none focus:border-foreground focus-visible:ring-2 focus-visible:ring-foreground/25";

/** Square multi-line input. */
export const textArea =
  "w-full min-h-28 border border-foreground/15 bg-background p-3 font-mono text-xs focus:outline-none focus:border-foreground focus-visible:ring-2 focus-visible:ring-foreground/25";

/** Bordered note box. */
export const noteBox = "border border-foreground/10 p-4 space-y-2";

/** One choice of a small radio group: square, filled when chosen. */
export const choiceChip =
  "min-h-10 px-3 py-2 border border-foreground/15 text-left text-sm hover:border-foreground/40 aria-checked:border-foreground aria-checked:bg-foreground aria-checked:text-background focus-visible:outline-2 focus-visible:outline-offset-2";
