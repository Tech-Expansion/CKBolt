/**
 * One switch for decorative motion: the system "reduce motion" setting, or the
 * page's own Pause motion button. Components listen for MOTION_EVENT to react.
 */
export const MOTION_EVENT = "ckbolt:motion";
const STORAGE_KEY = "ckbolt-motion";

/**
 * The root layout's inline script: it restores the visitor's Pause motion choice before the first paint. The node pages'
 * Content-Security-Policy allows it by its hash (lib/csp.ts), so it is one constant, used as it is.
 */
export const MOTION_RESTORE_SCRIPT = `try{if(localStorage.getItem('${STORAGE_KEY}')==='paused')document.documentElement.dataset.motion='paused'}catch(e){}`;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

export function motionPaused(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.motion === "paused" || prefersReducedMotion();
}

export function setMotionPaused(paused: boolean) {
  if (paused) document.documentElement.dataset.motion = "paused";
  else delete document.documentElement.dataset.motion;
  try {
    localStorage.setItem(STORAGE_KEY, paused ? "paused" : "on");
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts for this page only.
  }
  window.dispatchEvent(new Event(MOTION_EVENT));
}
