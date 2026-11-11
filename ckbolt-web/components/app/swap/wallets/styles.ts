/** Class names of the Fiber node's chip and dialog, and the card's small controls (docs/style-guide.md, App UI patterns). */

/** The compact Fiber node chip on the Fiber box of the swap card. */
export const walletChip =
  "inline-flex h-9 max-w-[13rem] min-w-0 items-center gap-2 rounded-full border border-foreground/15 px-3 text-sm hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40";

/** Pill button (h-10). */
export const pillButton =
  "inline-flex h-10 items-center justify-center gap-2 rounded-full border border-foreground/20 px-4 text-sm hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-40";

/** Text button for secondary actions. */
export const textButton = "min-h-10 px-3 -mx-3 text-sm text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40";

/** Square text input. */
export const textInput =
  "w-full h-11 border border-foreground/15 bg-background px-3 font-mono text-xs focus:outline-none focus:border-foreground focus-visible:ring-2 focus-visible:ring-foreground/25";

/** One choice of the Fiber wallet dialog (a radio). */
export const optionCard =
  "flex w-full items-start gap-3 border border-foreground/15 p-4 text-left hover:border-foreground/40 aria-checked:border-foreground focus-visible:outline-2 focus-visible:outline-offset-2";

/** Small mono label. */
export const monoLabel = "font-mono text-xs text-muted-foreground";

/** Link in running text. */
export const inlineLink = "underline underline-offset-4 hover:text-foreground";
