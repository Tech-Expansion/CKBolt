import { MOTION_EVENT, motionPaused } from "./motion";

/**
 * Runs a decorative canvas animation without wasting the main thread: it draws
 * only while the canvas is on screen and the tab is visible, at most about 30
 * frames a second, and with motion off (system setting or the page's Pause button)
 * it draws one still frame.
 * `speed` is how far `time` advances per 60 fps frame. Returns a cleanup function.
 */
export function startCanvasLoop(
  canvas: HTMLCanvasElement,
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number, time: number) => void,
  speed: number,
): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  let width = 0;
  let height = 0;
  let time = 0;
  let frame = 0;
  let last = 0;
  let onScreen = true;
  // About 30 fps on desktop, 15 on touch devices.
  const frameMs = window.matchMedia?.("(pointer: coarse)").matches ? 66 : 33;

  const running = () => onScreen && !document.hidden && !motionPaused();
  const paint = () => {
    ctx.clearRect(0, 0, width, height);
    draw(ctx, width, height, time);
  };
  // Measured once per resize instead of every frame.
  const resize = () => {
    // Capped: these are soft background textures, and full 3x resolution costs phones a lot.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const rect = canvas.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint();
  };
  const tick = (now: number) => {
    frame = 0;
    if (!running()) return;
    if (now - last >= frameMs) {
      const elapsed = last ? Math.min(now - last, 100) : 33;
      last = now;
      time += (speed * elapsed) / 16.7;
      paint();
    }
    frame = requestAnimationFrame(tick);
  };
  const start = () => {
    if (frame || !running()) return;
    last = 0;
    frame = requestAnimationFrame(tick);
  };

  const observer = new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    start();
  });
  observer.observe(canvas);
  document.addEventListener("visibilitychange", start);
  window.addEventListener(MOTION_EVENT, start);
  window.addEventListener("resize", resize);
  resize();
  start();

  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    document.removeEventListener("visibilitychange", start);
    window.removeEventListener(MOTION_EVENT, start);
    window.removeEventListener("resize", resize);
  };
}
