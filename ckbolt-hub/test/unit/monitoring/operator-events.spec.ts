import { OperatorEvents, type OperatorEvent } from "../../../src/application/monitoring/operator-events";

/** OperatorEvents: the in-process bus the swap machinery reports on for the monitor. Reporting never breaks a swap step. */

const CLOSED: OperatorEvent = { kind: "payout-guard-closed", swapId: "swap-1", channelId: "0x01" };
const PASS_OK: OperatorEvent = { kind: "swap-pass-ok" };

describe("OperatorEvents", () => {
  it("delivers each emitted event to a listener added with on()", () => {
    const events = new OperatorEvents();
    const heard: OperatorEvent[] = [];
    events.on((event) => heard.push(event));

    events.emit(CLOSED);
    events.emit(PASS_OK);

    expect(heard).toEqual([CLOSED, PASS_OK]);
  });

  it("delivers to every listener", () => {
    const events = new OperatorEvents();
    const first = jest.fn();
    const second = jest.fn();
    events.on(first);
    events.on(second);

    events.emit(CLOSED);

    expect(first).toHaveBeenCalledWith(CLOSED);
    expect(second).toHaveBeenCalledWith(CLOSED);
  });

  it("stops delivering to a listener once its unsubscribe is called, and keeps the others", () => {
    const events = new OperatorEvents();
    const leaving = jest.fn();
    const staying = jest.fn();
    const unsubscribe = events.on(leaving);
    events.on(staying);

    unsubscribe();
    events.emit(CLOSED);

    expect(leaving).not.toHaveBeenCalled();
    expect(staying).toHaveBeenCalledWith(CLOSED);
  });

  it("takes an unsubscribe called twice", () => {
    const events = new OperatorEvents();
    const unsubscribe = events.on(jest.fn());
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });

  it("does nothing on emit with no listener", () => {
    expect(() => new OperatorEvents().emit(CLOSED)).not.toThrow();
  });

  it("skips a listener that throws: emit does not throw and the next listener still hears the event", () => {
    const events = new OperatorEvents();
    const after = jest.fn();
    events.on(() => {
      throw new Error("monitor bug");
    });
    events.on(after);

    expect(() => events.emit(CLOSED)).not.toThrow();
    expect(after).toHaveBeenCalledWith(CLOSED);
  });
});
