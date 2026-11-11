import type { FiberPaymentStatus } from "../../../src/application/ports/fiber.port";
import { SwapSchedulerService } from "../../../src/application/swaps/swap-scheduler.service";
import { SWAP_STATE } from "../../../src/common/constants/swap.constants";
import type { SwapState } from "../../../src/domain/types";
import { spyOnLogger } from "../api/api.fixtures";
import {
  API_PATH,
  createSwap,
  lightningQuote,
  postDemoInvoice,
  postQuote,
  startFakeHub,
  startPaidDemoSwap,
  type FakeHub,
} from "./integration.fixtures";

/**
 * Shutdown order of the composed app (docs/architecture.md): Nest destroys the feature modules first (the swap
 * scheduler stops taking work and waits for what runs), then closes the HTTP server; the database closes last, on
 * application shutdown. Each test closes its own app, so the order can be observed.
 */

/** A promise the test resolves by hand, and a way to wait until some code has reached it. */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Records the shutdown steps the app goes through, in order. The database step also records the swap's saved state. */
function recordShutdown(hub: FakeHub, swapId?: string): string[] {
  const order: string[] = [];
  const stopScheduler = SwapSchedulerService.prototype.onModuleDestroy;
  jest.spyOn(SwapSchedulerService.prototype, "onModuleDestroy").mockImplementation(async function (this: SwapSchedulerService) {
    await stopScheduler.call(this);
    order.push("scheduler stopped");
  });
  hub.app.getHttpServer().on("close", () => order.push("http closed"));
  const closeStore = hub.store.close.bind(hub.store);
  jest.spyOn(hub.store, "close").mockImplementation(() => {
    const state: SwapState | undefined = swapId ? hub.store.getSwap(swapId)?.state : undefined;
    order.push(state ? `database closed (swap ${state})` : "database closed");
    closeStore();
  });
  return order;
}

describe("Shutdown order of the composed app", () => {
  let hub: FakeHub | undefined;

  beforeEach(() => spyOnLogger());

  afterEach(async () => {
    await hub?.app.close();
    hub = undefined;
    jest.restoreAllMocks();
  });

  it("swap work running at shutdown finishes and is saved before the database closes", async () => {
    hub = await startFakeHub();
    const running = hub;
    const payout = gate();
    const payInvoice = running.hubFiber.payInvoice.bind(running.hubFiber);
    let payoutCalls = 0;
    jest.spyOn(running.hubFiber, "payInvoice").mockImplementation(async (args): Promise<FiberPaymentStatus> => {
      payoutCalls += 1;
      await payout.opened;
      return payInvoice(args);
    });
    // The demo payment's push hint starts the swap's work in the scheduler; it stops inside the payout call.
    const { swap } = await startPaidDemoSwap(running, "ln_to_fiber", "CKB");
    await until(() => payoutCalls === 1);
    const order = recordShutdown(running, swap.id);

    const closing = running.app.close();
    hub = undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual([]);

    payout.open();
    await closing;

    expect(order).toEqual(["scheduler stopped", "http closed", `database closed (swap ${SWAP_STATE.SUCCEEDED})`]);
  });

  it("an HTTP request in progress at shutdown is answered, and saved, before the database closes", async () => {
    hub = await startFakeHub();
    const running = hub;
    const prices = gate();
    let fetches = 0;
    for (const source of running.prices) {
      const fetch = source.fetch.bind(source);
      jest.spyOn(source, "fetch").mockImplementation(async () => {
        fetches += 1;
        await prices.opened;
        return fetch();
      });
    }
    const order = recordShutdown(running);
    const saveQuote = running.store.saveQuote.bind(running.store);
    jest.spyOn(running.store, "saveQuote").mockImplementation((quote) => {
      saveQuote(quote);
      order.push("quote saved");
    });

    const answer = running.http().post(API_PATH.QUOTES).set("Connection", "close").send(lightningQuote("ln_to_fiber", "CKB")).then((res) => res);
    await until(() => fetches === running.prices.length);
    const closing = running.app.close();
    hub = undefined;
    prices.open();
    const res = await answer;
    await closing;

    expect(res.status).toBe(201);
    // The scheduler and the request run side by side; both are done before the server closes, and the database is last.
    expect([...order].sort()).toEqual(["database closed", "http closed", "quote saved", "scheduler stopped"]);
    expect(order.indexOf("quote saved")).toBeLessThan(order.indexOf("http closed"));
    expect(order.indexOf("scheduler stopped")).toBeLessThan(order.indexOf("http closed"));
    expect(order.at(-1)).toBe("database closed");
  });

  it("node push hints after shutdown start no swap work", async () => {
    hub = await startFakeHub();
    const running = hub;
    const quote = await postQuote(running, lightningQuote("fiber_to_ln", "CKB"));
    const swap = await createSwap(running, quote.id, (await postDemoInvoice(running, quote)).invoice, true);
    const processSwap = jest.spyOn(running.engine, "processSwap");

    await running.app.close();
    hub = undefined;

    expect(() => running.hubFiber.emit(swap.paymentHash)).not.toThrow();
    expect(() => running.hubLn.emit(swap.paymentHash)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(processSwap).not.toHaveBeenCalled();
  });

  it("the scheduler's timer stops with the app: no pass runs after shutdown", async () => {
    hub = await startFakeHub({ env: { SWAP_POLL_INTERVAL_MS: "10" } });
    const running = hub;
    const processOpenSwaps = jest.spyOn(running.engine, "processOpenSwaps");
    await until(() => processOpenSwaps.mock.calls.length > 0);

    await running.app.close();
    hub = undefined;
    const callsAtClose = processOpenSwaps.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(processOpenSwaps.mock.calls.length).toBe(callsAtClose);
  });
});
