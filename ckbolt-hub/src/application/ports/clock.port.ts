/** Time source, injected so tests can move time. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
