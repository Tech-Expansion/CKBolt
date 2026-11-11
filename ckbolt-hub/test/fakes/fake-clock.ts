import type { Clock } from "../../src/application/ports/clock.port";

/** A clock tests move by hand. */
export class FakeClock implements Clock {
  constructor(private current = Date.UTC(2026, 9, 23, 12, 0, 0)) {}

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(ms: number): void {
    this.current = ms;
  }
}
