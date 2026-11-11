import type { KeyValueStore } from "./storage";

/**
 * What the browser node needs from the page. fiber-js allocates SharedArrayBuffers, which exist only on a
 * cross-origin-isolated page: next.config.mjs sends Document-Isolation-Policy (Chromium) and COOP/COEP (others) on
 * /app/fiber only, so the CCC wallet popups on /app keep working.
 */
export interface IsolationReport {
  /** `crossOriginIsolated`: the headers took effect. */
  isolated: boolean;
  sharedMemory: boolean;
  /** HTTPS or localhost. */
  secureContext: boolean;
  webLocks: boolean;
  /** BroadcastChannel, the bridge to the swap form. */
  bridge: boolean;
}

export interface IsolationScope {
  crossOriginIsolated?: boolean;
  isSecureContext?: boolean;
  SharedArrayBuffer?: unknown;
  BroadcastChannel?: unknown;
  navigator?: { locks?: unknown };
}

export function checkIsolation(scope: IsolationScope = globalThis as IsolationScope): IsolationReport {
  return {
    isolated: scope.crossOriginIsolated === true,
    sharedMemory: typeof scope.SharedArrayBuffer === "function",
    secureContext: scope.isSecureContext === true,
    webLocks: !!scope.navigator?.locks,
    bridge: typeof scope.BroadcastChannel === "function",
  };
}

/** Value stored once the page has reloaded itself for isolation. */
const RELOADED_MARK = "1";

/** The node can start here. */
export const canRunNode = (report: IsolationReport): boolean => report.isolated && report.sharedMemory && report.secureContext;

/**
 * A client-side navigation into the page keeps the previous document's (non-isolated) state; one reload fetches the
 * page's own headers. True when the page should reload now; it records the reload so it happens once per tab.
 */
export function reloadOnceForIsolation(report: IsolationReport, session: KeyValueStore | null, key: string): boolean {
  if (!session) return false;
  if (report.isolated) {
    // Isolated now: a later arrival without isolation may reload once again.
    session.removeItem(key);
    return false;
  }
  if (!report.secureContext) return false;
  if (session.getItem(key) !== null) return false;
  session.setItem(key, RELOADED_MARK);
  return true;
}
