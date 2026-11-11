"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { webStore } from "@/lib/wallets/fiber-browser/storage";
import {
  clampPopupPoint,
  forgetPopupPoint,
  POPUP_POSITION,
  popupKeyMove,
  readPopupPoint,
  rememberPopupPoint,
  type PopupPoint,
  type PopupSize,
} from "@/lib/wallets/fiber-popup/popup-position";

/** Marks the move handle's own button (`data-move-grip`), the one control inside the title bar a drag may start from. */
const MOVE_GRIP_ATTR = "data-move-grip";

/** Controls inside the title bar keep their click: a press on them never starts a drag (Close). */
const CONTROLS = "a, button, input, select, textarea, [role='button'], [tabindex]:not([tabindex='-1'])";

/** The inline styles a moved popup carries over its anchored classes; removed, it is anchored again. */
const PLACED = ["left", "top", "right", "bottom", "transform"] as const;

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  /** The popup's top-left when the press began. */
  from: PopupPoint;
  /** Where it is now (clamped). */
  at: PopupPoint;
  /** Read once when the press begins, so a move reads no layout. */
  box: PopupSize;
  viewport: PopupSize;
  moved: boolean;
}

/** The viewport fixed elements are placed in: without the scroll bars. */
const viewportSize = (): PopupSize => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });
const boxSize = (el: HTMLElement): PopupSize => ({ width: el.offsetWidth, height: el.offsetHeight });

/** True when the press began on a control of the bar other than the move handle. */
function onOtherControl(event: { target: EventTarget; currentTarget: HTMLElement }): boolean {
  const control = event.target instanceof Element ? event.target.closest(CONTROLS) : null;
  return !!control && event.currentTarget.contains(control) && !control.hasAttribute(MOVE_GRIP_ATTR);
}

/** Puts the popup at `point` (its top-left in the viewport) with a transform, or back on its anchored classes. */
function place(el: HTMLElement, point: PopupPoint | null) {
  if (!point) {
    for (const name of PLACED) el.style.removeProperty(name);
    return;
  }
  el.style.left = "0px";
  el.style.top = "0px";
  el.style.right = "auto";
  el.style.bottom = "auto";
  el.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
}

export interface PopupDrag {
  /** The popup is a panel that can move (from `sm` up); on a phone it is a sheet and nothing here does anything. */
  movable: boolean;
  /** A press on the handle is under way: the iframe takes no pointer events meanwhile, or it would swallow the moves. */
  dragging: boolean;
  /** For the title bar: drag it, double-click it to put the popup back. */
  handleProps: {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
    onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
    onDoubleClick: (event: MouseEvent<HTMLElement>) => void;
  };
  /** For the move handle's button: arrow keys move the popup (Shift for big steps), Home puts it back. */
  onGripKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * Lets the visitor move the Fiber node popup by its title bar (docs/fiber-wallet-popup.md, "Moving the popup"): pointer
 * events with pointer capture, a transform written once per animation frame, the popup kept inside the viewport while
 * it moves and when the window resizes, and the place kept in localStorage for the next visit (clamped again on load).
 * The place the visitor chose is kept as chosen; only what shows is clamped, so a window made smaller and then larger
 * again gets the popup back where it was left.
 */
export function usePopupDrag(popoverRef: RefObject<HTMLElement | null>, open: boolean): PopupDrag {
  const [movable, setMovable] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** Where the visitor left it, or null: anchored. */
  const [point, setPoint] = useState<PopupPoint | null>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef(0);

  // The place kept from an earlier visit, read once the page runs (the popup itself renders only after a click).
  useEffect(() => {
    setPoint(readPopupPoint(webStore("localStorage")));
  }, []);

  // A panel from sm up, a sheet below: the same breakpoint as its classes.
  useEffect(() => {
    const query = window.matchMedia(POPUP_POSITION.MOVABLE_QUERY);
    const update = () => setMovable(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  /** Puts the popup where the visitor left it, clamped to the viewport as it is now, or anchored. */
  const settle = useCallback(() => {
    const el = popoverRef.current;
    if (!el || drag.current) return;
    place(el, movable && point ? clampPopupPoint(point, boxSize(el), viewportSize()) : null);
  }, [popoverRef, movable, point]);

  // Shown, moved, reset, or crossing the breakpoint: place it before the browser paints. Hidden, it has no size.
  useLayoutEffect(() => {
    if (open) settle();
  }, [open, settle]);

  // A window made smaller never leaves it outside: clamp again on resize, once per frame.
  useEffect(() => {
    if (!open || !movable || !point) return;
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(settle);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
    };
  }, [open, movable, point, settle]);

  const keep = useCallback((next: PopupPoint | null) => {
    setPoint(next);
    const store = webStore("localStorage");
    if (next) rememberPopupPoint(store, next);
    else forgetPopupPoint(store);
  }, []);

  /** Ends a press: a drag keeps its place; a click (no move past the threshold) changes nothing. */
  const finish = useCallback(
    (pointerId?: number) => {
      const current = drag.current;
      if (!current || (pointerId !== undefined && pointerId !== current.pointerId)) return;
      drag.current = null;
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      setDragging(false);
      if (!current.moved) return;
      if (popoverRef.current) place(popoverRef.current, current.at);
      keep(current.at);
    },
    [popoverRef, keep],
  );

  // Hidden in the middle of a drag (Escape, or the header button), or narrowed into a sheet: end it where it is, so the
  // iframe never stays without pointer events.
  useEffect(() => {
    if (!open || !movable) finish();
  }, [open, movable, finish]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    const el = popoverRef.current;
    if (!movable || !el || drag.current || !event.isPrimary || event.button !== 0 || onOtherControl(event)) return;
    const rect = el.getBoundingClientRect();
    const from = { x: rect.left, y: rect.top };
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, from, at: from, box: boxSize(el), viewport: viewportSize(), moved: false };
    // Pressed on the bar itself, focus stays where it was (a field in the node keeps it); the grip takes it.
    if (!(event.target instanceof Element && event.target.closest(`[${MOVE_GRIP_ATTR}]`))) event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The pointer is already gone: the press ends with its pointerup or never moves the popup.
    }
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.moved && Math.hypot(dx, dy) < POPUP_POSITION.DRAG_THRESHOLD_PX) return;
    current.moved = true;
    current.at = clampPopupPoint({ x: current.from.x + dx, y: current.from.y + dy }, current.box, current.viewport);
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const now = drag.current;
      if (now && popoverRef.current) place(popoverRef.current, now.at);
    });
  };

  const onPointerEnd = (event: PointerEvent<HTMLElement>) => finish(event.pointerId);

  const onDoubleClick = (event: MouseEvent<HTMLElement>) => {
    if (!movable || onOtherControl(event)) return;
    keep(null);
  };

  const onGripKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const el = popoverRef.current;
    if (!movable || !el || drag.current || event.altKey || event.ctrlKey || event.metaKey) return;
    const move = popupKeyMove(event.key, event.shiftKey);
    if (!move) return;
    event.preventDefault();
    if (move === "reset") return keep(null);
    const rect = el.getBoundingClientRect();
    keep(clampPopupPoint({ x: rect.left + move.dx, y: rect.top + move.dy }, boxSize(el), viewportSize()));
  };

  return {
    movable,
    dragging,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onLostPointerCapture: onPointerEnd,
      onDoubleClick,
    },
    onGripKeyDown,
  };
}
