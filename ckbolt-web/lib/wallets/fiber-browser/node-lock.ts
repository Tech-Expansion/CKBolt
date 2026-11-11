/**
 * One tab runs the node. fiber-js does nothing to stop two tabs from starting the same node on the same IndexedDB,
 * which would corrupt its channel state, so the page holds a Web Lock for as long as its node runs.
 */

export interface NodeLockHandle {
  release(): void;
  /** False when the browser has no Web Locks: the node runs, but nothing stops a second tab. */
  exclusive: boolean;
}

/** The part of `navigator.locks` used here; injectable for tests. */
export interface LockManagerLike {
  request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void> | void): Promise<unknown>;
  query?(): Promise<{ held?: { name?: string }[] }>;
}

const browserLocks = (): LockManagerLike | null =>
  typeof navigator !== "undefined" && navigator.locks ? (navigator.locks as unknown as LockManagerLike) : null;

/** Takes the lock if no other tab holds it; null when one does. Without Web Locks, a non-exclusive handle. */
export function acquireNodeLock(name: string, locks: LockManagerLike | null = browserLocks()): Promise<NodeLockHandle | null> {
  if (!locks) return Promise.resolve({ release: () => undefined, exclusive: false });
  return new Promise((resolve, reject) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        // The lock is held until this promise settles, i.e. until release().
        return new Promise<void>((release) => resolve({ release: () => release(), exclusive: true }));
      })
      .catch(reject);
  });
}

/** True when another tab already runs the node, so the page can say so before asking for the password. */
export async function isNodeLockHeld(name: string, locks: LockManagerLike | null = browserLocks()): Promise<boolean> {
  if (!locks?.query) return false;
  try {
    const snapshot = await locks.query();
    return (snapshot.held ?? []).some((lock) => lock.name === name);
  } catch {
    return false;
  }
}
