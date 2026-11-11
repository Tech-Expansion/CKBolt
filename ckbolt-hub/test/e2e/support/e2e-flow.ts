import { LEG_NETWORK } from "../../../src/domain/swap";
import type { Direction, FiberAsset, FiberAssetId } from "../../../src/domain/types";
import type { DemoInvoiceDto, QuoteDto, SwapDto } from "../../../src/interfaces/http/contract/responses";
import { createSwap, isFinished, lightningSideQuote, postDemoInvoice, postQuote, waitForSwap, type HubHttp } from "../../support/hub-http";
import { pollUntil } from "../../support/poll";
import { connectDevnet, userBalances, type DevnetNodes, type SwapSides, type UserBalances } from "./devnet-nodes";
import { createTempDatabase, startE2eHub, type E2eHub, type E2eHubOptions, type TempDatabase } from "./e2e-hub";
import { loadE2eSettings } from "./e2e.settings";

/** Steps and checks the e2e scenarios share. */

const settings = loadE2eSettings();
const pollOptions = { timeoutMs: settings.waitTimeoutMs, intervalMs: settings.pollIntervalMs };

/* ---------------------------------------------------------------------------------------------- lifecycle */

export interface E2eContext {
  readonly nodes: DevnetNodes;
  /** Starts a hub on this file's database; every hub started here is closed after each test. */
  startHub(options?: Omit<E2eHubOptions, "databasePath">): Promise<E2eHub>;
}

const setUp = <T>(value: T | undefined, name: string): T => {
  if (value === undefined) throw new Error(`The e2e ${name} is set up in beforeAll: use it inside a test.`);
  return value;
};

/**
 * Per test file: the devnet's nodes and a fresh SQLite database, removed afterwards. Hubs a test starts are closed
 * after it, so a failed test never leaves a hub working on the nodes.
 */
export function useE2eContext(): E2eContext {
  let nodes: DevnetNodes | undefined;
  let database: TempDatabase | undefined;
  const running: E2eHub[] = [];

  beforeAll(async () => {
    nodes = await connectDevnet();
    database = createTempDatabase();
  });
  afterEach(async () => {
    for (const hub of running.splice(0)) await hub.close();
  });
  afterAll(() => database?.remove());

  return {
    get nodes() {
      return setUp(nodes, "devnet nodes");
    },
    async startHub(options = {}) {
      const hub = await startE2eHub({ ...options, databasePath: setUp(database, "database").path });
      running.push(hub);
      return hub;
    },
  };
}

/* ------------------------------------------------------------------------------------------------- waiting */

/** Reads until `done` holds (or the e2e wait times out) and returns the last value, for an expect. */
export const eventually = <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => pollUntil(read, done, pollOptions);

/** Reads until the value equals `expected` (or the e2e wait times out) and returns the last value, for an expect. */
export const eventuallyEquals = <T>(read: () => Promise<T>, expected: T): Promise<T> => eventually(read, (value) => value === expected);

/** Waits until the hub is done with the swap (succeeded, or failed and refunded) and returns it as the API shows it. */
export const waitForFinishedSwap = (hub: HubHttp, swapId: string): Promise<SwapDto> =>
  waitForSwap(hub, swapId, isFinished, settings.waitTimeoutMs, settings.pollIntervalMs);

/** Sleeps until the wall clock passes `isoTime` (e.g. a quote's expiresAt). */
export async function sleepUntil(isoTime: string): Promise<void> {
  const ms = Date.parse(isoTime) - Date.now();
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

/* --------------------------------------------------------------------------------------------- swap steps */

export interface DemoSwap {
  quote: QuoteDto;
  payout: DemoInvoiceDto;
  swap: SwapDto;
}

/** Quote with the Lightning side fixed at `sats`, the demo wallet's payout invoice for it, and the swap (not paid yet). */
export async function createDemoSwap(hub: HubHttp, direction: Direction, asset: FiberAssetId, sats: bigint): Promise<DemoSwap> {
  const quote = await postQuote(hub, lightningSideQuote(direction, asset, sats));
  const payout = await postDemoInvoice(hub, quote);
  const swap = await createSwap(hub, quote.id, payout.invoice, true);
  return { quote, payout, swap };
}

export const requireAsset = (hub: E2eHub, id: FiberAssetId): FiberAsset => {
  const asset = hub.assets.get(id);
  if (!asset) throw new Error(`The hub does not serve ${id} on the devnet: is UDT_${id}_SCRIPT in devnet/hub.env?`);
  return asset;
};

/* ----------------------------------------------------------------------------------------- end state on nodes */

/**
 * Both legs settled on one preimage, as the nodes report it: the hub's hold invoice settled, the user's payout invoice
 * paid, the user's payment succeeded with `preimage`, and the swap's Lightning invoice settled with it.
 */
export async function expectSettledOnNodes(sides: SwapSides, paymentHash: string, preimage: string): Promise<void> {
  const { hold, payout, payment } = sides.states;
  expect(await eventuallyEquals(() => sides.holdInvoiceStatus(paymentHash), hold.settled)).toBe(hold.settled);
  expect(await eventuallyEquals(() => sides.payoutInvoiceStatus(paymentHash), payout.settled)).toBe(payout.settled);
  const userPayment = await eventually(() => sides.userPayment(paymentHash), (record) => record.status === payment.succeeded);
  expect(userPayment).toEqual({ status: payment.succeeded, preimage });
  expect(await sides.lightningInvoicePreimage(paymentHash)).toBe(preimage);
}

/** The hub's hold invoice cancelled (or expired) and, when the user paid it, the user's payment failed: funds back. */
export async function expectRefundedOnNodes(sides: SwapSides, paymentHash: string, options: { paid: boolean }): Promise<void> {
  const { hold, payment } = sides.states;
  const released = await eventually(() => sides.holdInvoiceStatus(paymentHash), (status) => status !== null && hold.released.includes(status));
  expect(hold.released).toContain(released);
  if (!options.paid) return;
  const userPayment = await eventually(() => sides.userPayment(paymentHash), (record) => record.status === payment.failed);
  expect(userPayment.status).toBe(payment.failed);
}

/* ---------------------------------------------------------------------------------------------- balances */

/** How the user's channel balances move when the swap succeeds: it pays the quote's pay leg and gets its receive leg. */
export const balanceChangeOf = (quote: QuoteDto): UserBalances => ({
  ...NO_BALANCE_CHANGE,
  [quote.pay.network]: -BigInt(quote.pay.amount),
  [quote.receive.network]: BigInt(quote.receive.amount),
});

export const NO_BALANCE_CHANGE: UserBalances = { [LEG_NETWORK.LIGHTNING]: 0n, [LEG_NETWORK.FIBER]: 0n };

const balanceChange = (before: UserBalances, after: UserBalances): UserBalances => ({
  [LEG_NETWORK.LIGHTNING]: after.lightning - before.lightning,
  [LEG_NETWORK.FIBER]: after.fiber - before.fiber,
});

const sameBalances = (a: UserBalances, b: UserBalances): boolean => a.lightning === b.lightning && a.fiber === b.fiber;

/**
 * The user's channel balances with the hub (Lightning sats, Fiber `asset`) moved by exactly `expected` since `before`.
 * Waits for it: a channel's balance follows the payment's outcome by a commitment round.
 */
export async function expectBalancesMoved(nodes: DevnetNodes, asset: FiberAsset, before: UserBalances, expected: UserBalances): Promise<void> {
  const after = await eventually(() => userBalances(nodes, asset), (balances) => sameBalances(balanceChange(before, balances), expected));
  expect(balanceChange(before, after)).toEqual(expected);
}
