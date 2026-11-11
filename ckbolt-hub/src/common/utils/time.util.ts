import { MS_PER_DAY, MS_PER_SECOND } from "../constants/protocol.constants";

export const secondsToMs = (seconds: number): number => seconds * MS_PER_SECOND;
export const msToSeconds = (ms: number): number => Math.floor(ms / MS_PER_SECOND);
/** Whole seconds that cover `ms` (rounded up), e.g. for a Retry-After header. */
export const msToSecondsCeil = (ms: number): number => Math.ceil(ms / MS_PER_SECOND);
/** Whole seconds left until `deadline`, never negative. */
export const secondsUntil = (deadline: number, now: number): number => Math.max(0, Math.floor((deadline - now) / MS_PER_SECOND));
/** Whole seconds to wait from `now` to reach `deadline` (rounded up), never negative. */
export const secondsToWait = (deadline: number, now: number): number => Math.max(0, Math.ceil((deadline - now) / MS_PER_SECOND));
export const toIso = (ms: number): string => new Date(ms).toISOString();
/** Midnight UTC that starts the day of `ms` (Unix time has no leap seconds: every UTC day is MS_PER_DAY long). */
export const utcDayStart = (ms: number): number => Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
/** Midnight UTC that ends the day of `ms`. */
export const nextUtcDayStart = (ms: number): number => utcDayStart(ms) + MS_PER_DAY;
