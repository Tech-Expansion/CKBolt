/** Class names of the Fiber node popup (style guide: App UI patterns). */

/** Small mono label. */
export const monoLabel = "font-mono text-xs text-muted-foreground";

/** The section heading inside a page. */
export const sectionTitle = "font-mono text-xs text-muted-foreground";

/** One of Home's large buttons (two by two): an icon over the page's name. */
export const homeAction =
  "flex min-h-20 w-full flex-col items-center justify-center gap-2 border border-foreground/10 px-2 py-3 text-sm hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-offset-2";

/** A sub-page's top bar: Back, then the page's title. */
export const pageBar = "flex shrink-0 items-center gap-2 border-b border-foreground/10 px-2 py-1.5";

/** Back, in a sub-page's top bar. */
export const backButton =
  "inline-flex h-10 items-center gap-1 px-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2";

/**
 * The popover around the node: a full-height sheet on a phone, a panel anchored top-right from sm up. A panel the visitor
 * moved carries its place as inline styles over these (use-popup-drag.ts); the grabbing cursor shows while it moves.
 */
export const popover =
  "fixed inset-0 z-[60] flex flex-col bg-background sm:inset-auto sm:right-4 sm:top-[5.5rem] sm:h-[600px] sm:max-h-[calc(100dvh-6.5rem)] sm:w-[380px] sm:border sm:border-foreground/15 sm:shadow-lg data-dragging:cursor-grabbing";

/** The popover's title bar: its title, state and Testnet badges, and Close. From sm up it is the handle that moves it. */
export const popoverTitleBar =
  "group/handle relative flex shrink-0 items-center justify-between gap-3 border-b border-foreground/10 px-4 py-2";

/** The title bar while the popup can move: the grab cursor, no text selection, no touch scrolling while dragging. */
export const popoverHandle = "cursor-grab touch-none select-none data-dragging:cursor-grabbing";

/** The move handle's button: a grip in the title bar's left padding, darker while the bar is hovered or it has focus. */
export const popoverGrip =
  "absolute inset-y-0 left-0 inline-flex w-4 cursor-grab items-center justify-start text-muted-foreground group-hover/handle:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 group-data-dragging/handle:cursor-grabbing";

/** The header button while the node runs: a faint Fiber-green outline and hover. */
export const walletButtonRunning = "border-fiber/30 hover:bg-fiber-soft aria-expanded:bg-fiber-soft";

/** The header button: a pill with a status dot and a short label; smaller on a phone, where it shares the bar with the menu. */
export const walletButton =
  "inline-flex h-9 min-w-0 max-w-[11rem] items-center gap-1.5 rounded-full border border-foreground/15 px-2.5 text-xs whitespace-nowrap hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-offset-2 aria-expanded:bg-foreground/5 sm:gap-2 sm:px-3 sm:text-sm";
