import type { TimingResult } from "./timing.types";

/** The failing branch of every TimingResult. */
export interface TimingFailure {
  ok: false;
  reason: string;
}

export const timingOk = <T extends object>(value: T): TimingResult<T> => ({ ...value, ok: true as const });

export const timingFail = (reason: string): TimingFailure => ({ ok: false, reason });
