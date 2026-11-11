import type { KeyValueStore } from "../fiber-browser/storage";

/**
 * Where the visitor moved the Fiber node popup (docs/fiber-wallet-popup.md, "Moving the popup"). From `sm` up the popup
 * is a panel anchored top right; its title bar drags it anywhere in the window, the arrow keys move it, and a double
 * click or Home puts it back. The place is a per-viewer convenience kept in this browser's localStorage; nothing else
 * depends on it, so a blocked or broken store only means the popup opens anchored.
 */

/** A point in the viewport's CSS pixels: the popup's top-left corner. */
export interface PopupPoint {
  x: number;
  y: number;
}

/** A width and a height in CSS pixels: the popup's, or the viewport's. */
export interface PopupSize {
  width: number;
  height: number;
}

export const POPUP_POSITION = {
  /** localStorage key of the place the visitor left the popup at: `{"x":…,"y":…}`. */
  STORAGE_KEY: "ckbolt:fiber-wallet:position",
  /** The popup can move where it is a panel: from Tailwind's `sm` (40rem), as its classes (styles.ts). A phone's sheet cannot. */
  MOVABLE_QUERY: "(min-width: 40rem)",
  /** The gap it keeps from the viewport's edges, so its border and shadow stay in sight. */
  MARGIN_PX: 8,
  /** A press that moves less than this is a click, not a drag: the popup stays anchored. */
  DRAG_THRESHOLD_PX: 3,
  /** One arrow key press; with Shift, the big step. */
  STEP_PX: 10,
  BIG_STEP_PX: 50,
  /** A stored point further out than this is not one the page wrote. */
  MAX_COORD_PX: 100_000,
} as const;

function clampAxis(value: number, size: number, room: number, margin: number): number {
  const free = room - size;
  // Larger than the viewport (it never is: its height is capped by the viewport's): pin it to the start.
  if (free <= 0) return 0;
  const edge = Math.min(margin, free / 2);
  return Math.round(Math.min(Math.max(value, edge), free - edge));
}

/** Keeps the popup wholly inside the viewport, `margin` away from its edges, on whole pixels (text stays sharp). */
export function clampPopupPoint(point: PopupPoint, box: PopupSize, viewport: PopupSize, margin: number = POPUP_POSITION.MARGIN_PX): PopupPoint {
  return { x: clampAxis(point.x, box.width, viewport.width, margin), y: clampAxis(point.y, box.height, viewport.height, margin) };
}

/** What a key does on the popup's move handle: a step, Home (back to its anchored place), or nothing. */
export type PopupKeyMove = { dx: number; dy: number } | "reset" | null;

/** Arrow keys move the popup by STEP_PX, with Shift by BIG_STEP_PX; Home puts it back. Other keys are left alone. */
export function popupKeyMove(key: string, shift: boolean): PopupKeyMove {
  const step = shift ? POPUP_POSITION.BIG_STEP_PX : POPUP_POSITION.STEP_PX;
  switch (key) {
    case "ArrowLeft":
      return { dx: -step, dy: 0 };
    case "ArrowRight":
      return { dx: step, dy: 0 };
    case "ArrowUp":
      return { dx: 0, dy: -step };
    case "ArrowDown":
      return { dx: 0, dy: step };
    case "Home":
      return "reset";
    default:
      return null;
  }
}

const isCoord = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= POPUP_POSITION.MAX_COORD_PX;

/** The stored point, or null when nothing (or nothing this page wrote) is stored. Its x and y only. */
export function parsePopupPoint(text: string | null): PopupPoint | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { x, y } = value as Record<string, unknown>;
  return isCoord(x) && isCoord(y) ? { x: Math.round(x), y: Math.round(y) } : null;
}

export const serializePopupPoint = (point: PopupPoint): string => JSON.stringify({ x: Math.round(point.x), y: Math.round(point.y) });

/** Where the visitor left the popup, or null (anchored) when nothing is kept or the store is blocked. */
export function readPopupPoint(store: KeyValueStore | null): PopupPoint | null {
  try {
    return parsePopupPoint(store?.getItem(POPUP_POSITION.STORAGE_KEY) ?? null);
  } catch {
    return null;
  }
}

/** Keeps the place for the next visit; a full or blocked store keeps nothing, and the popup still moves. */
export function rememberPopupPoint(store: KeyValueStore | null, point: PopupPoint): void {
  try {
    store?.setItem(POPUP_POSITION.STORAGE_KEY, serializePopupPoint(point));
  } catch {
    // A per-viewer convenience: nothing to tell the visitor.
  }
}

/** Forgets the place: the popup opens anchored again. */
export function forgetPopupPoint(store: KeyValueStore | null): void {
  try {
    store?.removeItem(POPUP_POSITION.STORAGE_KEY);
  } catch {
    // As above.
  }
}
