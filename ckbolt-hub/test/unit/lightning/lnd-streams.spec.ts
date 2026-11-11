import { EventEmitter } from "node:events";
import { Logger, type LoggerService } from "@nestjs/common";
import { LND_PAYMENT_FAILURE_REASON } from "../../../src/common/constants/lnd.constants";
import { LndPaymentFollower } from "../../../src/infrastructure/lightning/lnd-payment-follower";
import { LndUpdateFeed } from "../../../src/infrastructure/lightning/lnd-update-feed";
import type { LndLightningAdapter } from "../../../src/infrastructure/lightning/lnd-lightning.adapter";
import { GRPC_CODE, LND_DETAILS, PAYMENT_HASH, PREIMAGE, libError, newPreimage } from "./lightning.fixtures";
import { LndPackageSimulator, confirmedEvent, createAdapter, failedEvent, payingEvent } from "./lnd-package.simulator";

const silentLogger = (): LoggerService & { warn: jest.Mock } => ({ log: jest.fn(), error: jest.fn(), warn: jest.fn() });

/* ------------------------------------------------------------------------------------------- onUpdate (adapter) */

describe("LndLightningAdapter.onUpdate", () => {
  let sim: LndPackageSimulator;
  let adapter: LndLightningAdapter;

  beforeEach(() => {
    sim = new LndPackageSimulator();
    adapter = createAdapter(sim);
  });

  afterEach(() => {
    adapter.close();
    jest.restoreAllMocks();
  });

  it("opens no invoice stream until someone listens", () => {
    expect(sim.rpc.subscribeToInvoices).not.toHaveBeenCalled();
    adapter.onUpdate(jest.fn());
    expect(sim.rpc.subscribeToInvoices).toHaveBeenCalledWith({ lnd: sim.lnd });
  });

  it("shares one invoice stream between listeners and passes each update's hash as Hex32", () => {
    const first = jest.fn();
    const second = jest.fn();
    adapter.onUpdate(first);
    adapter.onUpdate(second);

    sim.invoiceStreams[0]!.emit("invoice_updated", { id: PAYMENT_HASH.toUpperCase() });

    expect(sim.rpc.subscribeToInvoices).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(PAYMENT_HASH);
    expect(second).toHaveBeenCalledWith(PAYMENT_HASH);
  });

  it("reports hold-invoice transitions made through the adapter", async () => {
    const listener = jest.fn();
    adapter.onUpdate(listener);
    await adapter.createHoldInvoice({ paymentHash: PAYMENT_HASH, amountSats: 1_000n, expirySeconds: 180, cltvExpiry: 144, memo: "swap" });
    sim.acceptHtlcs(PAYMENT_HASH, [700]);
    await adapter.settleInvoice(PREIMAGE);
    expect(listener).toHaveBeenNthCalledWith(1, PAYMENT_HASH);
    expect(listener).toHaveBeenNthCalledWith(2, PAYMENT_HASH);
  });

  it("stops calling a listener once it unsubscribes", () => {
    const kept = jest.fn();
    const dropped = jest.fn();
    adapter.onUpdate(kept);
    const unsubscribe = adapter.onUpdate(dropped);

    unsubscribe();
    sim.invoiceStreams[0]!.emit("invoice_updated", { id: PAYMENT_HASH });

    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it("ends the invoice stream when the last listener leaves, and opens a new one for the next listener", () => {
    const unsubscribe = adapter.onUpdate(jest.fn());
    const stream = sim.invoiceStreams[0]!;
    unsubscribe();
    expect(stream.listenerCount("invoice_updated")).toBe(0);

    const listener = jest.fn();
    adapter.onUpdate(listener);
    expect(sim.invoiceStreams).toHaveLength(2);
    sim.invoiceStreams[1]!.emit("invoice_updated", { id: PAYMENT_HASH });
    expect(listener).toHaveBeenCalledWith(PAYMENT_HASH);
  });

  it("keeps notifying the other listeners when one throws, and never throws into the LND stream", () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const failing = jest.fn(() => {
      throw new Error("listener bug");
    });
    const healthy = jest.fn();
    adapter.onUpdate(failing);
    adapter.onUpdate(healthy);

    expect(() => sim.invoiceStreams[0]!.emit("invoice_updated", { id: PAYMENT_HASH })).not.toThrow();
    expect(healthy).toHaveBeenCalledWith(PAYMENT_HASH);
    expect(warn).toHaveBeenCalled();
  });

  it("survives an invoice stream error: it is logged and payment outcomes still arrive", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const listener = jest.fn();
    adapter.onUpdate(listener);

    expect(() => sim.invoiceStreams[0]!.emit("error", libError("UnexpectedInvoiceSubscriptionError", GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED))).not.toThrow();
    expect(warn).toHaveBeenCalled();

    const request = sim.addPayable({ hash: PAYMENT_HASH, cltvDelta: 40 });
    sim.onPay = (stream) => stream.emit("paying", payingEvent(PAYMENT_HASH));
    await adapter.payInvoice({ paymentRequest: request, maxFeeSats: 10n, cltvLimit: 200, timeoutSeconds: 30 });
    sim.lastPayCall().stream.emit("confirmed", confirmedEvent(PAYMENT_HASH, PREIMAGE));
    expect(listener).toHaveBeenCalledWith(PAYMENT_HASH);
  });

  it("opens a new invoice stream for the next listener after the old one ended", () => {
    adapter.onUpdate(jest.fn());
    sim.invoiceStreams[0]!.emit("end");
    adapter.onUpdate(jest.fn());
    expect(sim.invoiceStreams).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------------------------------------ LndUpdateFeed */

describe("LndUpdateFeed", () => {
  it("delivers notify() hints to every listener without an invoice stream event", () => {
    const stream = new EventEmitter();
    const feed = new LndUpdateFeed(() => stream, silentLogger());
    const listener = jest.fn();
    feed.subscribe(listener);
    feed.notify(PAYMENT_HASH);
    expect(listener).toHaveBeenCalledWith(PAYMENT_HASH);
  });

  it("drops every listener and the stream on close", () => {
    const stream = new EventEmitter();
    const feed = new LndUpdateFeed(() => stream, silentLogger());
    const listener = jest.fn();
    feed.subscribe(listener);
    feed.close();
    feed.notify(PAYMENT_HASH);
    expect(listener).not.toHaveBeenCalled();
    expect(stream.listenerCount("invoice_updated")).toBe(0);
  });

  it("ignores an `end` from a stream it already replaced", () => {
    const streams = [new EventEmitter(), new EventEmitter()];
    let opened = 0;
    const feed = new LndUpdateFeed(() => streams[opened++]!, silentLogger());
    const unsubscribe = feed.subscribe(jest.fn());
    unsubscribe();
    const listener = jest.fn();
    feed.subscribe(listener);

    streams[0]!.emit("end");
    feed.subscribe(jest.fn());

    expect(opened).toBe(2);
    streams[1]!.emit("invoice_updated", { id: PAYMENT_HASH });
    expect(listener).toHaveBeenCalledWith(PAYMENT_HASH);
  });
});

/* ------------------------------------------------------------------------------------------ LndPaymentFollower */

describe("LndPaymentFollower", () => {
  const { hash } = newPreimage();

  it("resolves IN_FLIGHT on `paying`, then reports the final outcome through onChange only", async () => {
    const onChange = jest.fn();
    const follower = new LndPaymentFollower(onChange);
    const stream = new EventEmitter();

    const first = follower.follow(hash, stream);
    stream.emit("paying", payingEvent(hash));
    await expect(first).resolves.toMatchObject({ paymentHash: hash, state: "IN_FLIGHT" });
    expect(onChange).not.toHaveBeenCalled();
    expect(follower.isFollowing(hash)).toBe(true);

    stream.emit("failed", failedEvent(hash, { is_pathfinding_timeout: true }));
    expect(onChange).toHaveBeenCalledWith(hash);
    expect(follower.isFollowing(hash)).toBe(false);
  });

  it("resolves with a final outcome that comes first, and reports it", async () => {
    const onChange = jest.fn();
    const follower = new LndPaymentFollower(onChange);
    const stream = new EventEmitter();

    const result = follower.follow(hash, stream);
    stream.emit("failed", failedEvent(hash, { is_invalid_payment: true }));
    await expect(result).resolves.toMatchObject({ state: "FAILED", failureReason: LND_PAYMENT_FAILURE_REASON.INCORRECT_PAYMENT_DETAILS });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("rejects with the stream's error when it breaks before any status, without onChange", async () => {
    const onChange = jest.fn();
    const follower = new LndPaymentFollower(onChange);
    const stream = new EventEmitter();
    const error = libError("UnexpectedPaymentError", GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED);

    const result = follower.follow(hash, stream);
    stream.emit("error", error);
    await expect(result).rejects.toBe(error);
    expect(onChange).not.toHaveBeenCalled();
    expect(follower.isFollowing(hash)).toBe(false);
  });

  it("followInBackground turns an early break into an onChange hint instead of an unhandled rejection", async () => {
    const onChange = jest.fn();
    const follower = new LndPaymentFollower(onChange);
    const stream = new EventEmitter();
    follower.followInBackground(hash, stream);

    stream.emit("error", libError("UnexpectedGetPaymentError", GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED));
    await new Promise((resolve) => setImmediate(resolve));
    expect(onChange).toHaveBeenCalledWith(hash);
  });

  it("stopAll releases every stream", () => {
    const follower = new LndPaymentFollower(jest.fn());
    const streams = [new EventEmitter(), new EventEmitter()];
    void follower.follow(hash, streams[0]!);
    void follower.follow(newPreimage().hash, streams[1]!);

    follower.stopAll();

    for (const stream of streams) expect(stream.listenerCount("confirmed")).toBe(0);
    expect(follower.isFollowing(hash)).toBe(false);
  });
});
