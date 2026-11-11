import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import {
  ManualFiberStep,
  type FiberInvoiceRequest,
  type FiberWalletApi,
  type FiberWalletState,
} from "../../components/app/swap/contracts";
import { useLightningInvoice } from "../../components/app/get-paid/use-lightning-invoice";
import { useSwapForm } from "../../components/app/swap/use-swap-form";
import { useFiberWalletController } from "../../components/app/swap/wallets/use-fiber-wallet-controller";
import { HubClientProvider } from "../../hooks/use-hub-client";
import type { HubStatus } from "../../hooks/use-hub-status";
import { useSwapRunner, type SwapPlan, type SwapRun } from "../../hooks/use-swap-runner";
import { localeDecimalMark } from "../../lib/amount";
import type { OpenRequest } from "../../lib/get-paid/request";
import { encodeUnsignedBolt11 } from "../../lib/bolt11";
import { HubClient } from "../../lib/hub/client";
import { HUB_CLIENT_TIMING, HUB_PROXY_BASE_PATH, type HttpMethod } from "../../lib/hub/constants";
import {
  API_ERROR_CODE,
  HUB_PROXY_ERROR_CODE,
  SWAP_CANCEL_TOKEN_HEADER,
  SWAP_EVENT,
  type AssetDto,
  type CreateQuoteBody,
  type CreateSwapBody,
  type Direction,
  type FiberAssetId,
  type HealthDto,
  type LegDto,
  type QuoteDto,
  type SwapDto,
  type SwapEventDto,
} from "../../lib/hub/contract";
import { matchHubRoute } from "../../lib/hub/routes";
import { demoFiberInvoice } from "../../lib/payment-request";
import { readPayAmount, type PayUnit } from "../../lib/swap/amount";
import { CARD_ERROR, OWN_INVOICE_COPY, RUN_ERROR, STEP_LINE } from "../../lib/swap/copy";
import { checkLimits, quotable } from "../../lib/swap/limits";
import { primaryButtonState, type PrimaryAction, type PrimaryButtonInput } from "../../lib/swap/primary-button";
import { isRunSettled } from "../../lib/swap/run-model";
import { BridgeError } from "../../lib/wallets/fiber-browser/bridge-client";
import {
  BRIDGE_ERROR,
  BRIDGE_METHOD,
  errorResponse,
  okResponse,
  parseRequest,
  type BridgeErrorCode,
  type BridgeMethod,
  type BridgeRequest,
  type MakeInvoiceParams,
  type NodePresence,
  type PayInvoiceParams,
} from "../../lib/wallets/fiber-browser/bridge-protocol";
import { BRIDGE_CHANNEL_NAME, BRIDGE_TIMING } from "../../lib/wallets/fiber-browser/constants";
import { FIBER_WALLET_KIND_STORAGE_KEY, FIBER_WALLET_KINDS } from "../../lib/wallets/fiber-wallet/constants";
import { FIBER_WALLET_MESSAGE, FIBER_WALLET_PROBLEM } from "../../lib/wallets/fiber-wallet/messages";
import { LN_WALLET_MESSAGE } from "../../lib/wallets/lightning/messages";
import { WeblnPayStore } from "../../lib/wallets/lightning/pay-store";
import type { WebLnProvider } from "../../lib/wallets/lightning/webln-wallet";
import { amountlessInvoice } from "../e2e/fakes/hub";

/*
 * The live swap card, tested from its spec (docs/live-swap-ui.md, with "One wallet") rather than from its code:
 * - the primary button's table, every row and "the first matching state wins";
 * - amounts and per-swap limits;
 * - the card's form (the real useSwapForm), driven the way a visitor types, flips and pastes their own invoice;
 * - the run (the real useSwapRunner) in both directions with a fake Fiber node, a fake browser wallet (WebLN) and a
 *   fake hub: success, refund, cancel, refusals and "Try again" without paying twice, the hold invoice to pay by hand;
 * - the Fiber wallet (the real controller behind FiberWalletProvider) over a fake node tab on the real bridge.
 *
 * Hooks render with React DOM into a stub container (the unit project has no browser). The hub is a fake `fetch` given
 * to the hooks through HubClientProvider, and the global fetch refuses every call, so nothing leaves the process.
 */

/* ============================================================================================== fixtures */

const CKB = (whole: number): string => (BigInt(whole) * BigInt(100_000_000)).toString();
const hex32 = (): string => randomBytes(32).toString("hex");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Mutinynet's tip on 2026-10-23, as the hub reports it. */
const HUB_HEIGHT = 3_528_733;
const HEALTH: HealthDto = {
  status: "ok",
  version: "0.1.0",
  lightning: { reachable: true, network: "signet", synced: true, blockHeight: HUB_HEIGHT },
  fiber: { reachable: true, network: "testnet", version: "0.9.1" },
  demo: { enabled: true },
  swaps: { paused: false },
};

/** The spec's example limits: "Min 1,000 sats", "Max 20,000 sats". */
const hubAsset = (id: FiberAssetId, overrides: Partial<AssetDto> = {}): AssetDto => ({
  id,
  symbol: id,
  name: id === "CKB" ? "Nervos CKB" : "RUSD stablecoin",
  displayName: null,
  iconUrl: null,
  decimals: 8,
  directions: ["ln_to_fiber", "fiber_to_ln"],
  minSats: "1000",
  maxSats: "20000",
  liquidity: { lightningSats: "5000000", fiberAmount: CKB(1_000_000) },
  ...overrides,
});

const lightningInvoice = (o: { sats: number; hash?: Buffer; expirySeconds?: number; network?: "signet" | "mainnet" }) =>
  encodeUnsignedBolt11({
    network: o.network ?? "signet",
    amountSats: o.sats,
    paymentHash: o.hash ?? randomBytes(32),
    description: "CKBolt",
    expirySeconds: o.expirySeconds ?? 600,
  });

/** How long the tests wait for things that happen by themselves. */
const TICK_MS = 20;
const WAIT_MS = 5_000;
const QUOTE_WAIT_MS = HUB_CLIENT_TIMING.quoteDebounceMs + 2_000;
/** Long enough for the runner's next GET /v1/swaps/:id. */
const POLL_WAIT_MS = HUB_CLIENT_TIMING.swapPollMs * 2 + 2_000;
const STATUS_WAIT_MS = BRIDGE_TIMING.statusWindowMs + 2_000;

/* ================================================================================ hooks without a browser */

/** Web Storage in memory. */
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
}

const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const ELEMENT_NODE = 1;
const noop = () => undefined;

/**
 * What React DOM needs to render hooks that draw nothing, installed for one test and removed after it, so other spec
 * files in the same worker never see it: a stub window and document, the act() environment flag, a sessionStorage,
 * and a global fetch that refuses (and counts) every call.
 */
class Sandbox {
  readonly sessionStorage = new MemoryStorage();
  strayFetches = 0;
  private readonly saved = new Map<string, PropertyDescriptor | undefined>();
  private readonly document = { activeElement: null, body: null, addEventListener: noop, removeEventListener: noop, defaultView: null as unknown };
  private readonly window = { event: undefined, document: this.document, HTMLIFrameElement: class {}, addEventListener: noop, removeEventListener: noop };

  install() {
    this.document.defaultView = this.window;
    this.set("window", this.window);
    this.set("IS_REACT_ACT_ENVIRONMENT", true);
    this.set("sessionStorage", this.sessionStorage);
    this.set("fetch", () => {
      this.strayFetches += 1;
      return Promise.reject(new Error("Unit tests make no network calls."));
    });
  }

  /** A fresh element-like container for one React root. */
  container(): Element {
    const container = { nodeType: ELEMENT_NODE, tagName: "DIV", namespaceURI: XHTML_NAMESPACE, ownerDocument: this.document, textContent: "" };
    return Object.assign(container, { addEventListener: noop, removeEventListener: noop }) as unknown as Element;
  }

  restore() {
    const g = globalThis as Record<string, unknown>;
    for (const [key, descriptor] of this.saved) {
      if (descriptor) Object.defineProperty(g, key, descriptor);
      else delete g[key];
    }
    this.saved.clear();
  }

  private set(key: string, value: unknown) {
    this.saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true, enumerable: false });
  }
}

/** The globals the sandbox replaces, as they were before any test: other spec files in this worker must get them back. */
const SANDBOXED_GLOBALS = ["window", "IS_REACT_ACT_ENVIRONMENT", "sessionStorage", "fetch"] as const;
const globalsBefore = SANDBOXED_GLOBALS.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));

test.afterAll(() => {
  expect(SANDBOXED_GLOBALS.map((key) => Object.getOwnPropertyDescriptor(globalThis, key))).toEqual(globalsBefore);
});

let sandbox: Sandbox;
let cleanups: (() => Promise<void> | void)[] = [];
/** A bridge status window may still be open when a test ends; its answer must land before the stub window goes. */
let bridgeUsed = false;

test.beforeEach(() => {
  sandbox = new Sandbox();
  sandbox.install();
  cleanups = [];
  bridgeUsed = false;
});

test.afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  if (bridgeUsed) await sleep(BRIDGE_TIMING.statusWindowMs + 200);
  const strays = sandbox.strayFetches;
  sandbox.restore();
  expect(strays, "requests that went past the fake hub").toBe(0);
});

interface Hooked<P, R> {
  /** What the hook returned on its latest render. */
  readonly current: R;
  rerender(props: P): Promise<void>;
}

/** Renders `hook` in a component that draws nothing, inside `wrap`; unmounted after the test. */
async function renderHook<P, R>(hook: (props: P) => R, props: P, wrap: (child: ReactElement) => ReactElement = (child) => child): Promise<Hooked<P, R>> {
  const box: { rendered: boolean; value: R | undefined } = { rendered: false, value: undefined };
  function Probe({ hookProps }: { hookProps: P }) {
    box.value = hook(hookProps);
    box.rendered = true;
    return null;
  }
  const root = createRoot(sandbox.container());
  const draw = (next: P) => root.render(wrap(createElement(Probe, { hookProps: next })));
  await act(async () => draw(props));
  cleanups.push(() => act(async () => root.unmount()));
  return {
    get current() {
      if (!box.rendered) throw new Error("The hook has not rendered.");
      return box.value as R;
    },
    rerender: (next) => act(async () => draw(next)),
  };
}

/** Lets timers, wallet answers, bridge answers and hub polls run (inside act) until `check` passes. */
async function until(check: () => boolean, what: string, timeoutMs = WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
    await act(() => sleep(TICK_MS));
  }
}

/** Lets `ms` pass with everything running, to show that nothing more happens. */
const pass = (ms: number) => act(() => sleep(ms));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/* ================================================================================================= hub */

interface HubFault {
  status: number;
  code: string;
  message: string;
}

const BTC_MICRO_USD = BigInt(80_000_000_000);
const ASSET_MICRO_USD: Record<FiberAssetId, bigint> = { CKB: BigInt(2_000), RUSD: BigInt(1_000_000), CWBTC: BTC_MICRO_USD };
const SATS_PER_BTC = BigInt(100_000_000);
const FEE_BPS = 100;
const BPS = BigInt(10_000);
const QUOTE_TTL_MS = 150_000;
const UNIT_ORIGIN = "http://unit.test";

/** The hub's failure reason for a swap its creator cancelled with its token. */
const CANCELLED_REASON = "Cancelled by its creator before anyone paid.";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const apiError = (fault: HubFault) => json(fault.status, { error: { code: fault.code, message: fault.message } });

/**
 * The CKBolt hub's REST API v1 (lib/hub/contract.ts) behind a fake fetch: quotes priced exactly (1 BTC = $80,000,
 * 1 CKB = $0.002, 1 RUSD = $1, fee 1%) on either side (`side: "receive"` fixes what the user receives and rounds what
 * they pay up), one swap per quote with a real-looking hold invoice, and swaps moved along by
 * the test with advance(). Every request is recorded by its route ("POST /v1/swaps", "GET /v1/swaps/:id"); a request
 * that is not a route of the contract, or not with its method, is recorded in `offContract`.
 */
class FakeHub {
  assets: AssetDto[] = [hubAsset("CKB"), hubAsset("RUSD")];
  /** The next quote and swap requests are answered with these errors, in order. */
  readonly quoteFaults: HubFault[] = [];
  readonly swapFaults: HubFault[] = [];
  readonly cancelFaults: HubFault[] = [];
  /** While set, POST /v1/swaps waits for it before it answers (a swap created after the page moved on). */
  swapGate: Promise<void> | null = null;
  /** Each swap's cancel token, as POST /v1/swaps answered it, by swap id. */
  readonly cancelTokens = new Map<string, string>();
  /** Every POST /v1/swaps/:id/cancel: the swap, the token header it carried (or null), the status answered. */
  readonly cancels: { id: string; token: string | null; status: number }[] = [];
  /** Replaces the hold invoice of the next swap: a hub that hands out an invoice that is not the swap's. */
  holdInvoice: ((swap: SwapDto) => string) | null = null;
  readonly requests: { key: string; body: unknown }[] = [];
  readonly offContract: string[] = [];
  /** Everything sent to the hub, URL and body as text. */
  readonly sent: string[] = [];
  readonly quotes = new Map<string, QuoteDto>();
  private readonly swaps = new Map<string, SwapDto>();
  private readonly events = new Map<string, SwapEventDto[]>();
  private readonly preimages = new Map<string, string>();
  readonly client = new HubClient({ fetch: (input, init) => this.answer(input, init) });

  count(key: string): number {
    return this.requests.filter((r) => r.key === key).length;
  }

  bodies(key: string): unknown[] {
    return this.requests.filter((r) => r.key === key).map((r) => r.body);
  }

  /** The newest swap of the test. */
  get lastSwap(): SwapDto {
    const swap = [...this.swaps.values()].at(-1);
    if (!swap) throw new Error("No swap yet.");
    return swap;
  }

  /** The one swap of the test. */
  get swap(): SwapDto {
    const [swap, ...more] = [...this.swaps.values()];
    if (!swap || more.length) throw new Error(`Expected one swap, found ${this.swaps.size}.`);
    return swap;
  }

  /** A quote as POST /v1/quotes would make it, without a request (the plan of a run). */
  issueQuote(body: CreateQuoteBody): QuoteDto {
    const quote = this.price(body);
    if ("status" in quote) throw new Error(quote.message);
    return quote;
  }

  /** Moves the swap along, as the hub's engine would, and logs events. */
  advance(patch: Partial<Pick<SwapDto, "state" | "refunded" | "failureReason">>, ...events: string[]) {
    const swap = this.swap;
    const at = new Date().toISOString();
    this.swaps.set(swap.id, { ...swap, ...patch, updatedAt: at });
    this.events.get(swap.id)!.push(...events.map((type) => ({ at, type, detail: type })));
  }

  /** The payout went through and the hub settled the held payment with the preimage. */
  succeed() {
    const swap = this.swap;
    this.advance({ state: "succeeded" }, SWAP_EVENT.PAYOUT_SUCCEEDED, SWAP_EVENT.SETTLED);
    this.swaps.set(swap.id, { ...this.swap, preimage: this.preimages.get(swap.id)! });
  }

  preimageOf(swap: SwapDto): string {
    return this.preimages.get(swap.id)!;
  }

  private price(body: CreateQuoteBody): QuoteDto | HubFault {
    const asset = this.assets.find((a) => a.id === body.asset);
    if (!asset || !asset.directions.includes(body.direction)) return { status: 422, code: API_ERROR_CODE.ASSET_UNAVAILABLE, message: "Not swapped here." };
    if ((body.side !== "pay" && body.side !== "receive") || !/^[1-9]\d*$/.test(body.amount)) {
      return { status: 400, code: API_ERROR_CODE.VALIDATION, message: "Bad amount." };
    }
    const unit = BigInt(10 ** asset.decimals);
    const keep = BPS - BigInt(FEE_BPS);
    const satMicroUsd = BTC_MICRO_USD / SATS_PER_BTC;
    const amount = BigInt(body.amount);
    const ceilDiv = (a: bigint, b: bigint) => (a + b - BigInt(1)) / b;
    const fiberLeg = (units: bigint): LegDto => ({ network: "fiber", asset: asset.id, amount: units.toString(), decimals: asset.decimals });
    const sats = (n: bigint): LegDto => ({ network: "lightning", asset: "BTC", amount: n.toString(), decimals: 0 });
    const receiving = body.side === "receive";
    let pay: LegDto;
    let receive: LegDto;
    let lightningSats: bigint;
    if (body.direction === "ln_to_fiber") {
      lightningSats = receiving ? ceilDiv(amount * ASSET_MICRO_USD[asset.id] * BPS, satMicroUsd * unit * keep) : amount;
      pay = sats(lightningSats);
      receive = fiberLeg(receiving ? amount : (amount * satMicroUsd * unit * keep) / (ASSET_MICRO_USD[asset.id] * BPS));
    } else {
      lightningSats = receiving ? amount : (amount * ASSET_MICRO_USD[asset.id] * keep) / (unit * satMicroUsd * BPS);
      pay = fiberLeg(receiving ? ceilDiv(amount * unit * satMicroUsd * BPS, ASSET_MICRO_USD[asset.id] * keep) : amount);
      receive = sats(lightningSats);
    }
    if (lightningSats < BigInt(asset.minSats) || lightningSats > BigInt(asset.maxSats)) {
      return { status: 422, code: API_ERROR_CODE.VALIDATION, message: `The Lightning leg must be ${asset.minSats} to ${asset.maxSats} sats.` };
    }
    const now = Date.now();
    const quote: QuoteDto = {
      id: randomUUID(),
      direction: body.direction,
      asset: asset.id,
      pay,
      receive,
      prices: { btcUsd: 80_000, assetUsd: Number(ASSET_MICRO_USD[asset.id]) / 1_000_000, source: "Test fixture", at: new Date(now).toISOString() },
      feeBps: FEE_BPS,
      purpose: body.purpose ?? "swap",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
      signature: "sig",
      hubPubkey: "02" + "ab".repeat(32),
    };
    this.quotes.set(quote.id, quote);
    return quote;
  }

  private createSwap(body: CreateSwapBody): SwapDto | HubFault {
    const quote = this.quotes.get(body.quoteId);
    if (!quote) return { status: 404, code: API_ERROR_CODE.NOT_FOUND, message: "No such quote." };
    if (Date.parse(quote.expiresAt) <= Date.now()) return { status: 410, code: API_ERROR_CODE.QUOTE_EXPIRED, message: "The quote expired." };
    if ([...this.swaps.values()].some((s) => s.quoteId === quote.id)) return { status: 409, code: API_ERROR_CODE.CONFLICT, message: "Taken." };
    if (typeof body.payoutInvoice !== "string" || !body.payoutInvoice) return { status: 422, code: API_ERROR_CODE.INVOICE_INVALID, message: "No invoice." };
    const preimage = randomBytes(32);
    const hash = createHash("sha256").update(preimage).digest();
    const id = randomUUID();
    const at = new Date().toISOString();
    const hold =
      quote.direction === "ln_to_fiber"
        ? lightningInvoice({ sats: Number(quote.pay.amount), hash, expirySeconds: QUOTE_TTL_MS / 1000 })
        : demoFiberInvoice("testnet", BigInt(quote.pay.amount));
    let swap: SwapDto = {
      id,
      quoteId: quote.id,
      direction: quote.direction,
      asset: quote.asset,
      state: "pending",
      paymentHash: hash.toString("hex"),
      pay: { ...quote.pay, invoice: hold },
      receive: { ...quote.receive, invoice: body.payoutInvoice },
      refunded: false,
      failureReason: null,
      preimage: null,
      demo: body.demo === true,
      quoteExpiresAt: quote.expiresAt,
      createdAt: at,
      updatedAt: at,
      links: { self: `/v1/swaps/${id}`, events: `/v1/swaps/${id}/events` },
    };
    if (this.holdInvoice) swap = { ...swap, pay: { ...swap.pay, invoice: this.holdInvoice(swap) } };
    this.swaps.set(id, swap);
    this.events.set(id, [{ at, type: SWAP_EVENT.CREATED, detail: "created" }]);
    this.preimages.set(id, preimage.toString("hex"));
    return swap;
  }

  /** As the hub: 403 without the swap's token; a pending swap fails, cancelled on request; again the same; else 409. */
  private cancel(id: string, token: string | null): Response {
    const answer = (status: number, response: Response) => {
      this.cancels.push({ id, token, status });
      return response;
    };
    const fault = this.cancelFaults.shift();
    if (fault) return answer(fault.status, apiError(fault));
    const swap = this.swaps.get(id);
    if (!swap) return answer(404, apiError({ status: 404, code: API_ERROR_CODE.NOT_FOUND, message: "No such swap." }));
    if (!token || token !== this.cancelTokens.get(id)) {
      return answer(403, apiError({ status: 403, code: API_ERROR_CODE.CANCEL_REFUSED, message: "No cancel token." }));
    }
    if (swap.state === "failed" && swap.failureReason === CANCELLED_REASON) return answer(200, json(200, swap));
    if (swap.state !== "pending") return answer(409, apiError({ status: 409, code: API_ERROR_CODE.CONFLICT, message: "Too late." }));
    const cancelled: SwapDto = { ...swap, state: "failed", refunded: true, failureReason: CANCELLED_REASON, updatedAt: new Date().toISOString() };
    this.swaps.set(id, cancelled);
    this.events.get(id)!.push({ at: cancelled.updatedAt, type: SWAP_EVENT.CANCELLED_ON_REQUEST, detail: CANCELLED_REASON });
    return answer(200, json(200, cancelled));
  }

  private async answer(input: string, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? "GET").toUpperCase();
    this.sent.push(`${method} ${input} ${typeof init?.body === "string" ? init.body : ""}`);
    const { pathname } = new URL(input, UNIT_ORIGIN);
    const segments = pathname.startsWith(`${HUB_PROXY_BASE_PATH}/`) ? pathname.slice(HUB_PROXY_BASE_PATH.length + 1).split("/") : [];
    const route = matchHubRoute(segments);
    if (!route || !route.methods.includes(method as HttpMethod)) {
      this.offContract.push(`${method} ${pathname}`);
      return apiError({ status: 405, code: HUB_PROXY_ERROR_CODE.METHOD_NOT_ALLOWED, message: "Not in the contract." });
    }
    const key = `${method} /${route.pattern.join("/")}`;
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    this.requests.push({ key, body });
    const id = segments[2];
    switch (key) {
      case "POST /v1/quotes": {
        const fault = this.quoteFaults.shift();
        if (fault) return apiError(fault);
        const quote = this.price(body as CreateQuoteBody);
        return "status" in quote ? apiError(quote) : json(201, quote);
      }
      case "POST /v1/swaps": {
        if (this.swapGate) await this.swapGate;
        const fault = this.swapFaults.shift();
        if (fault) return apiError(fault);
        const swap = this.createSwap(body as CreateSwapBody);
        if ("status" in swap) return apiError(swap);
        const cancelToken = hex32();
        this.cancelTokens.set(swap.id, cancelToken);
        return json(201, { ...swap, cancelToken });
      }
      case "POST /v1/swaps/:id/cancel":
        return this.cancel(id, (init?.headers as Record<string, string> | undefined)?.[SWAP_CANCEL_TOKEN_HEADER] ?? null);
      case "GET /v1/swaps/:id": {
        const swap = this.swaps.get(id);
        return swap ? json(200, swap) : apiError({ status: 404, code: API_ERROR_CODE.NOT_FOUND, message: "No such swap." });
      }
      case "GET /v1/swaps/:id/events":
        return json(200, { data: this.events.get(id) ?? [] });
      default:
        this.offContract.push(key);
        return apiError({ status: 404, code: API_ERROR_CODE.NOT_FOUND, message: "Not faked." });
    }
  }
}

const withHub = (hub: FakeHub) => (child: ReactElement) => createElement(HubClientProvider, { client: hub.client, children: child });

/* ============================================================================================= wallets */

/** The browser's WebLN wallet behind the page's pay store: records what it was asked; its answers are scripted. */
class FakeWebln {
  readonly paid: string[] = [];
  enables = 0;
  /** Answers to sendPayment in order; then paid. */
  readonly payAnswers: (() => Promise<{ preimage?: string }>)[] = [];
  readonly provider: WebLnProvider = {
    enable: async () => {
      this.enables += 1;
    },
    sendPayment: (invoice) => {
      this.paid.push(invoice);
      return (this.payAnswers.shift() ?? (async () => ({ preimage: hex32() })))();
    },
  };

  /** The page's store of browser wallet payments, with this wallet on the page, or with none. */
  store(present = true): WeblnPayStore {
    return new WeblnPayStore({ findWebLn: () => (present ? this.provider : null) });
  }
}

/** The extension says no: nothing was sent, so asking again is safe. */
const weblnRefusal = (message = "User rejected") => () => Promise.reject(new Error(message));
/** A closed prompt: the payment may be on its way. */
const weblnSilence = () => Promise.reject(new Error("Prompt was closed"));

const BROWSER_NODE: FiberWalletState = {
  kind: "browser-node",
  label: "CKBolt node",
  ready: true,
  /** Room for the largest swap (20,000 sats buy 7,920 CKB). */
  liquidity: { CKB: { send: CKB(50_000), receive: CKB(50_000) }, RUSD: { send: CKB(50_000), receive: CKB(50_000) } },
  problem: null,
  funds: null,
};
const OWN_NODE: FiberWalletState = { kind: "own-node", label: "External node", ready: true, liquidity: null, problem: null, funds: null };
const NO_FIBER_WALLET: FiberWalletState = { kind: null, label: null, ready: false, liquidity: null, problem: null, funds: null };

/**
 * A Fiber wallet behind the card's contract (components/app/swap/contracts.ts), scripted per test. The own node
 * rejects both actions with ManualFiberStep, as the contract says.
 */
class FakeFiberWallet {
  readonly made: FiberInvoiceRequest[] = [];
  readonly paid: { swapId: string; invoice: string }[] = [];
  /** Answers to makeInvoice in order; then an invoice of the hub's network for exactly the amount. */
  readonly makeAnswers: ((request: FiberInvoiceRequest) => Promise<string>)[] = [];
  /** Answers to payInvoice in order; then sent. */
  readonly payAnswers: (() => Promise<void>)[] = [];
  readonly api: FiberWalletApi;

  constructor(state: FiberWalletState) {
    const manual = state.kind === "own-node";
    this.api = {
      ...state,
      choose: noop,
      disconnect: noop,
      makeInvoice: async (request) => {
        this.made.push(request);
        if (manual) throw new ManualFiberStep();
        const answer = this.makeAnswers.shift();
        return answer ? answer(request) : demoFiberInvoice("testnet", BigInt(request.amount));
      },
      payInvoice: async (request) => {
        this.paid.push(request);
        if (manual) throw new ManualFiberStep();
        await (this.payAnswers.shift() ?? (async () => undefined))();
      },
    };
  }
}

type TabAnswer = { result: unknown } | { error: { code: BridgeErrorCode; message: string } };

const runningPresence = (patch: Partial<NodePresence> = {}): NodePresence => ({
  phase: "running",
  nodeId: "02" + "cd".repeat(32),
  network: "testnet",
  hubConnected: true,
  liquidity: { CKB: { send: CKB(5_000), receive: CKB(5_000) } },
  ...patch,
});

/**
 * The visitor's /app/fiber tab as the swap page meets it: a listener on the real same-origin BroadcastChannel that
 * answers the bridge protocol (status, make-invoice, pay-invoice) the way the node tab does, scripted per test.
 */
class FakeNodeTab {
  presence: NodePresence = runningPresence();
  readonly requests: BridgeRequest[] = [];
  readonly invoices: string[] = [];
  makeInvoice: (params: MakeInvoiceParams) => TabAnswer = (params) => {
    const invoice = demoFiberInvoice("testnet", BigInt(params.amount));
    this.invoices.push(invoice);
    return { result: { invoice, paymentHash: hex32() } };
  };
  payInvoice: (params: PayInvoiceParams) => TabAnswer = () => ({ result: { paymentHash: hex32(), status: "Inflight" } });
  private readonly channel = new BroadcastChannel(BRIDGE_CHANNEL_NAME);

  constructor() {
    this.channel.addEventListener("message", (event) => this.onMessage(event.data));
    cleanups.push(() => this.channel.close());
  }

  /** The params of each request of one method, in order. */
  calls(method: BridgeMethod): unknown[] {
    return this.requests.filter((r) => r.method === method).map((r) => ("params" in r ? r.params : null));
  }

  private onMessage(data: unknown) {
    const request = parseRequest(data);
    if (!request) return;
    this.requests.push(request);
    const answer = this.answerTo(request);
    this.channel.postMessage("error" in answer ? errorResponse(request.id, answer.error.code, answer.error.message) : okResponse(request.id, answer.result));
  }

  private answerTo(request: BridgeRequest): TabAnswer {
    switch (request.method) {
      case BRIDGE_METHOD.STATUS:
        return { result: this.presence };
      case BRIDGE_METHOD.MAKE_INVOICE:
        return this.makeInvoice(request.params);
      case BRIDGE_METHOD.PAY_INVOICE:
        return this.payInvoice(request.params);
      default:
        // Pay's requests are tested in tests/unit/pay.spec.ts.
        return { error: { code: BRIDGE_ERROR.INVALID_REQUEST, message: "not a swap request" } };
    }
  }
}

/** The state fields of a Fiber wallet, without its actions. */
const stateOf = ({ kind, label, ready, liquidity, problem, funds }: FiberWalletState): FiberWalletState => ({ kind, label, ready, liquidity, problem, funds });

/* ======================================================================================= primary button */

/**
 * The spec's table ("The primary button", with "One wallet"), in its order: each row's condition as a change to a card
 * that is ready to swap, and what the button must say and do. Labels are the spec's own words.
 */
const ROWS: { when: string; patch: Partial<PrimaryButtonInput>; label: string; action: PrimaryAction }[] = [
  { when: "the hub is not live", patch: { hubLive: false }, label: "Hub unavailable", action: "none" },
  { when: "there is no amount", patch: { amount: "empty", lnInvoice: "not-needed" }, label: "Enter an amount", action: "none" },
  { when: "the amount is zero", patch: { amount: "zero", lnInvoice: "not-needed" }, label: "Enter an amount", action: "none" },
  {
    when: "CKB or RUSD to BTC has neither an amount nor an invoice",
    patch: { amount: "empty", lnInvoice: "missing" },
    label: "Paste your Lightning invoice",
    action: "focus-ln-invoice",
  },
  { when: "it is below the minimum", patch: { limit: { kind: "min", sats: "1000" } }, label: "Min 1,000 sats", action: "none" },
  { when: "it is above the maximum", patch: { limit: { kind: "max", sats: "20000" } }, label: "Max 20,000 sats", action: "none" },
  { when: "it is above the liquidity", patch: { limit: { kind: "liquidity" } }, label: "Not enough liquidity", action: "none" },
  { when: "no Fiber node is chosen", patch: { fiber: { chosen: false, ready: false, problem: null } }, label: "Connect Fiber node", action: "connect-fiber" },
  {
    when: "the Fiber node is not ready",
    patch: { fiber: { chosen: true, ready: false, problem: "Open your Fiber node" } },
    label: "Open your Fiber node",
    action: "connect-fiber",
  },
  { when: "the browser node cannot send that much", patch: { shortfall: "send" }, label: "Not enough CKB to send", action: "connect-fiber" },
  { when: "the browser node cannot receive that much", patch: { shortfall: "receive" }, label: "Your node can't receive this much CKB", action: "connect-fiber" },
  { when: "the browser node can receive none of the token", patch: { shortfall: "no-channel" }, label: "Ask the hub for a channel first", action: "connect-fiber" },
  { when: "the visitor's Lightning invoice is missing", patch: { lnInvoice: "missing" }, label: "Paste your Lightning invoice", action: "focus-ln-invoice" },
  { when: "the visitor's Lightning invoice is refused", patch: { lnInvoice: "invalid" }, label: "Paste your Lightning invoice", action: "focus-ln-invoice" },
  { when: "the own node has no valid invoice", patch: { ownInvoice: "missing" }, label: "Paste your Fiber invoice", action: "focus-own-invoice" },
  { when: "the quote is loading", patch: { quote: "loading" }, label: "Getting quote…", action: "none" },
  { when: "the quote expired", patch: { quote: "expired" }, label: "Refresh quote", action: "refresh-quote" },
];

const READY_CARD: PrimaryButtonInput = {
  run: "none",
  hubLive: true,
  paused: false,
  amount: "ok",
  limit: null,
  fiber: { chosen: true, ready: true, problem: null },
  shortfall: null,
  symbol: "CKB",
  lnInvoice: "not-needed",
  ownInvoice: "not-needed",
  quote: "ready",
};

const button = (...patches: Partial<PrimaryButtonInput>[]) => primaryButtonState(Object.assign({}, READY_CARD, ...patches));

test.describe("the primary button (spec table)", () => {
  test("a card with everything in place says Swap and runs it", () => {
    expect(button()).toEqual({ label: "Swap", action: "swap", disabled: false });
    expect(button({ lnInvoice: "ok" })).toEqual({ label: "Swap", action: "swap", disabled: false });
  });

  for (const row of ROWS) {
    test(`when ${row.when}: "${row.label}"`, () => {
      // Disabled exactly when the table says so; every other state does something when pressed.
      expect(button(row.patch)).toEqual({ label: row.label, action: row.action, disabled: row.action === "none" });
    });
  }

  test("the first matching row wins over every row below it", () => {
    for (let i = 0; i < ROWS.length; i++) {
      // Every later row's condition holds too; the row's own patch goes last where two rows set the same field.
      const later = ROWS.slice(i + 1).map((r) => r.patch).reverse();
      expect(button(...later, ROWS[i].patch).label, `${ROWS[i].when}, with every later row`).toBe(ROWS[i].label);
      for (const below of ROWS.slice(i + 1)) {
        const shared = Object.keys(below.patch).some((key) => key in ROWS[i].patch);
        if (!shared) expect(button(below.patch, ROWS[i].patch).label, `${ROWS[i].when}, with: ${below.when}`).toBe(ROWS[i].label);
      }
    }
  });

  test("the browser node's shortfall names the token it pays", () => {
    expect(button({ shortfall: "send", symbol: "RUSD" }).label).toBe("Not enough RUSD to send");
  });

  test("while a swap runs, the button never offers a second one", () => {
    for (const row of [...ROWS, { patch: {} }]) {
      for (const run of ["running", "settled"] as const) expect(button(row.patch, { run }).action).toBe("view-progress");
    }
  });
});

/* ===================================================================================== amounts and limits */

test.describe("amounts and limits", () => {
  const mark = localeDecimalMark();
  const SATS: PayUnit = { network: "lightning", decimals: 0 };
  const ok = (units: string) => ({ status: "ok" as const, units });
  const limits = (sats: string | null, fiberUnits: string | null, quoteErrorCode: string | null = null) =>
    checkLimits({ asset: hubAsset("CKB"), sats, fiberUnits, quoteErrorCode, knownPrices: null });

  test("BTC is typed in whole sats; a Fiber token in its own units, with the asset's decimals", () => {
    expect(readPayAmount("2000", SATS, mark)).toEqual(ok("2000"));
    expect(readPayAmount(`2000${mark}5`, SATS, mark)).toEqual({ status: "invalid" });
    expect(readPayAmount(`1${mark}5`, { network: "fiber", decimals: 8 }, mark)).toEqual(ok("150000000"));
    expect(readPayAmount(`12${mark}5`, { network: "fiber", decimals: 6 }, mark)).toEqual(ok("12500000"));
    expect(readPayAmount("", SATS, mark)).toEqual({ status: "empty" });
    expect(readPayAmount("0", { network: "fiber", decimals: 8 }, mark)).toEqual({ status: "zero" });
  });

  test("the per-swap limits include their bounds", () => {
    expect(limits("999", null)).toEqual({ kind: "min", sats: "1000" });
    expect(limits("1000", null)).toBeNull();
    expect(limits("20000", null)).toBeNull();
    expect(limits("20001", null)).toEqual({ kind: "max", sats: "20000" });
  });

  test("BTC typed, or an invoice's sats, is checked before any quote; a typed Fiber amount goes to the hub", () => {
    const asset = hubAsset("CKB");
    expect(quotable({ asset, sats: "999", fiberUnits: null, knownPrices: null })).toBe(false);
    expect(quotable({ asset, sats: "1000", fiberUnits: null, knownPrices: null })).toBe(true);
    expect(quotable({ asset, sats: null, fiberUnits: "1", knownPrices: null })).toBe(true);
    expect(quotable({ asset, sats: null, fiberUnits: null, knownPrices: null })).toBe(false);
  });

  test("more than the hub can pay out is a liquidity limit, either way", () => {
    expect(limits("5000", null, API_ERROR_CODE.INSUFFICIENT_LIQUIDITY)).toEqual({ kind: "liquidity" });
    expect(limits(null, CKB(5_000), API_ERROR_CODE.INSUFFICIENT_LIQUIDITY)).toEqual({ kind: "liquidity" });
  });
});

/* ========================================================================================== the card form */

interface FormProps {
  status: HubStatus;
  fiber: FiberWalletApi;
  nowMs: number;
}

const hubStatus = (hub: FakeHub, live = true): HubStatus => ({
  state: live ? "live" : "offline",
  live,
  health: live ? HEALTH : null,
  assets: live ? hub.assets : [],
  refresh: async () => undefined,
});

async function renderForm(hub: FakeHub, props: FormProps) {
  return renderHook((p: FormProps) => useSwapForm({ hub: p.status, fiber: p.fiber, nowMs: p.nowMs, run: "none" }), props, withHub(hub));
}

/** The visitor's own Lightning invoice, as their wallet makes it: on the hub's network, for exactly `sats`. */
const visitorInvoice = (sats: string | number, o: { expirySeconds?: number; network?: "signet" | "mainnet"; timestamp?: number } = {}) =>
  encodeUnsignedBolt11({
    network: o.network ?? "signet",
    amountSats: Number(sats),
    paymentHash: randomBytes(32),
    description: "Alby Hub",
    expirySeconds: o.expirySeconds ?? 600,
    timestamp: o.timestamp,
  });

test.describe("the card's form", () => {
  const mark = localeDecimalMark();
  let hub: FakeHub;

  test.beforeEach(() => {
    hub = new FakeHub();
  });

  test.afterEach(() => {
    expect(hub.offContract, "requests outside the hub's REST contract").toEqual([]);
  });

  async function readyForm(fiber = new FakeFiberWallet(BROWSER_NODE).api) {
    const props: FormProps = { status: hubStatus(hub), fiber, nowMs: Date.now() };
    const form = await renderForm(hub, props);
    const type = (text: string) => act(async () => form.current.setAmountText(text));
    const paste = (text: string) => act(async () => form.current.setLnInvoiceText(text));
    const flip = () => act(async () => form.current.flip());
    const quoted = () => until(() => form.current.quote !== null && !form.current.quoteState.loading, "a quote", QUOTE_WAIT_MS);
    return { form, props, type, paste, flip, quoted };
  }

  test("hub not live: Hub unavailable, and nothing is quoted", async () => {
    const form = await renderForm(hub, { status: hubStatus(hub, false), fiber: new FakeFiberWallet(BROWSER_NODE).api, nowMs: Date.now() });
    await act(async () => form.current.setAmountText("2000"));
    await pass(QUOTE_WAIT_MS / 2);
    expect(form.current.primary).toEqual({ label: "Hub unavailable", action: "none", disabled: true });
    expect(hub.count("POST /v1/quotes")).toBe(0);
  });

  test("no amount, or zero: Enter an amount", async () => {
    const { form, type } = await readyForm();
    expect(form.current.primary).toEqual({ label: "Enter an amount", action: "none", disabled: true });
    await type("0");
    expect(form.current.primary).toEqual({ label: "Enter an amount", action: "none", disabled: true });
    expect(form.current.lnInvoiceNeeded).toBe(false);
  });

  test("BTC outside the per-swap limits is refused before any quote is asked for", async () => {
    const { form, type, quoted } = await readyForm();
    await type("999");
    expect(form.current.primary).toEqual({ label: "Min 1,000 sats", action: "none", disabled: true });
    await type("20001");
    expect(form.current.primary).toEqual({ label: "Max 20,000 sats", action: "none", disabled: true });
    await pass(QUOTE_WAIT_MS / 2);
    expect(hub.count("POST /v1/quotes")).toBe(0);

    await type("20000");
    await quoted();
    expect(form.current.primary.label).toBe("Swap");
    expect(hub.bodies("POST /v1/quotes")).toEqual([{ direction: "ln_to_fiber", asset: "CKB", side: "pay", amount: "20000" }]);
  });

  test("more than the hub can pay out: Not enough liquidity", async () => {
    hub.quoteFaults.push({ status: 422, code: API_ERROR_CODE.INSUFFICIENT_LIQUIDITY, message: "The hub cannot pay out 19,800 CKB now." });
    const { form, type } = await readyForm();
    await type("2000");
    await until(() => form.current.quoteState.error !== null, "the hub's refusal", QUOTE_WAIT_MS);
    expect(form.current.primary).toEqual({ label: "Not enough liquidity", action: "none", disabled: true });
    expect(form.current.error?.line).toBe(CARD_ERROR.LIQUIDITY);
  });

  test("then the one wallet, the Fiber node: Connect Fiber node, then the node's own problem; no Lightning wallet asked", async () => {
    const { form, props, type, quoted } = await readyForm(new FakeFiberWallet(NO_FIBER_WALLET).api);
    await type("2000");
    await quoted();
    expect(form.current.primary).toEqual({ label: "Connect Fiber node", action: "connect-fiber", disabled: false });

    const notReady = new FakeFiberWallet({ ...BROWSER_NODE, ready: false, liquidity: null, problem: "Open your Fiber node" }).api;
    await form.rerender({ ...props, fiber: notReady });
    expect(form.current.primary).toEqual({ label: "Open your Fiber node", action: "connect-fiber", disabled: false });

    await form.rerender({ ...props, fiber: new FakeFiberWallet(BROWSER_NODE).api });
    expect(form.current.primary).toEqual({ label: "Swap", action: "swap", disabled: false });
  });

  test("a browser node that cannot receive the payout: Your node can't receive this much CKB", async () => {
    // 2,000 sats buy 792 CKB; the node can receive 500.
    const fiber = new FakeFiberWallet({ ...BROWSER_NODE, liquidity: { CKB: { send: CKB(5_000), receive: CKB(500) } } }).api;
    const { form, type, quoted } = await readyForm(fiber);
    await type("2000");
    await quoted();
    expect(form.current.primary).toEqual({ label: "Your node can't receive this much CKB", action: "connect-fiber", disabled: false });
  });

  test("a browser node without a channel for the token: Ask the hub for a channel first", async () => {
    const fiber = new FakeFiberWallet({ ...BROWSER_NODE, liquidity: {} }).api;
    const { form, type, quoted } = await readyForm(fiber);
    await type("2000");
    await quoted();
    expect(form.current.primary).toEqual({ label: "Ask the hub for a channel first", action: "connect-fiber", disabled: false });
  });

  test("a browser node that cannot send what is paid: Not enough CKB to send, and the pay box says what it can", async () => {
    const fiber = new FakeFiberWallet({ ...BROWSER_NODE, liquidity: { CKB: { send: CKB(500), receive: CKB(5_000) } } }).api;
    const { form, type, flip, paste, quoted } = await readyForm(fiber);
    await flip();
    expect(form.current.direction).toBe("fiber_to_ln");
    await type("1000");
    expect(form.current.primary).toEqual({ label: "Not enough CKB to send", action: "connect-fiber", disabled: false });
    expect(form.current.payHint).toBe("Can send 500 CKB");
    await type("500");
    await quoted();
    expect(form.current.primary.label).toBe("Paste your Lightning invoice");
    // An invoice whose amount needs more than the node can send: the same, from the quote's pay amount.
    await paste(visitorInvoice(2_475));
    await until(() => form.current.quote?.receive.amount === "2475", "the invoice's quote", QUOTE_WAIT_MS);
    expect(form.current.primary.label).toBe("Not enough CKB to send");
  });

  test("own node, BTC to Fiber: Paste your Fiber invoice, until one for exactly the quote is pasted", async () => {
    const { form, type, quoted } = await readyForm(new FakeFiberWallet(OWN_NODE).api);
    await type("2000");
    expect(form.current.ownInvoiceNeeded).toBe(true);
    await quoted();
    expect(form.current.primary).toEqual({ label: "Paste your Fiber invoice", action: "focus-own-invoice", disabled: false });
    expect(form.current.plan).toBeNull();

    const receive = BigInt(form.current.quote!.receive.amount);
    await act(async () => form.current.setOwnInvoiceText(demoFiberInvoice("testnet", receive + BigInt(1))));
    expect(form.current.primary.label).toBe("Paste your Fiber invoice");
    expect(form.current.error?.line).toBe(OWN_INVOICE_COPY.INVALID);

    const pasted = demoFiberInvoice("testnet", receive);
    await act(async () => form.current.setOwnInvoiceText(pasted));
    expect(form.current.primary).toEqual({ label: "Swap", action: "swap", disabled: false });
    expect(form.current.plan?.payoutInvoice).toBe(pasted);
  });

  test("CKB to BTC, nothing typed: the card asks for the visitor's invoice; its amount is quoted exact out", async () => {
    const { form, flip, paste, quoted } = await readyForm();
    await flip();
    expect(form.current.lnInvoiceNeeded).toBe(true);
    expect(form.current.primary).toEqual({ label: "Paste your Lightning invoice", action: "focus-ln-invoice", disabled: false });
    expect(form.current.lnInvoicePlaceholder).toBe("lntbs…");
    expect(form.current.lnInvoiceTip).toContain("Bitcoin signet (Mutinynet)");
    await pass(QUOTE_WAIT_MS / 2);
    expect(hub.count("POST /v1/quotes")).toBe(0);

    const invoice = visitorInvoice(2_475);
    await paste(invoice);
    // The invoice's sats show at once; the pay box is fixed by the quote and cannot be typed.
    expect(form.current.receiveFigure).toBe("2,475");
    expect(form.current.amountFixed).toBe(true);
    await quoted();
    expect(hub.bodies("POST /v1/quotes")).toEqual([{ direction: "fiber_to_ln", asset: "CKB", side: "receive", amount: "2475" }]);
    // 2,475 sats at $80,000 per BTC and $0.002 per CKB, plus 1%: 1,000 CKB.
    expect(form.current.amountText).toBe("1,000");
    expect(form.current.quote?.receive.amount).toBe("2475");
    expect(form.current.lnInvoiceAsk).toBeNull();
    expect(form.current.primary).toEqual({ label: "Swap", action: "swap", disabled: false });
    expect(form.current.plan).toEqual({ quote: form.current.quote, symbol: "CKB", payoutInvoice: invoice });
  });

  test("CKB to BTC, an amount typed first: the card asks for an invoice of exactly the quoted sats, which then fixes it", async () => {
    const { form, type, flip, paste, quoted } = await readyForm();
    await flip();
    await type("1000");
    await quoted();
    expect(hub.bodies("POST /v1/quotes")).toEqual([{ direction: "fiber_to_ln", asset: "CKB", side: "pay", amount: CKB(1_000) }]);
    expect(form.current.receiveFigure).toBe("2,475");
    expect(form.current.lnInvoiceAsk).toBe("For exactly 2,475 sats");
    expect(form.current.primary).toEqual({ label: "Paste your Lightning invoice", action: "focus-ln-invoice", disabled: false });
    expect(form.current.plan).toBeNull();

    // Another amount in the invoice wins: it is quoted exact out, and the typed amount waits behind it.
    const invoice = visitorInvoice(3_000);
    await paste(invoice);
    await until(() => form.current.quote?.receive.amount === "3000", "the invoice's quote", QUOTE_WAIT_MS);
    expect(hub.bodies("POST /v1/quotes").at(-1)).toEqual({ direction: "fiber_to_ln", asset: "CKB", side: "receive", amount: "3000" });
    expect(form.current.amountFixed).toBe(true);
    expect(form.current.plan?.payoutInvoice).toBe(invoice);
    await paste("");
    expect(form.current.amountFixed).toBe(false);
    expect(form.current.amountText).toBe("1000");
  });

  test("CKB to BTC refusals, one line each and no swap: no amount, mainnet, expired, expiring before the quote", async () => {
    const { form, flip, paste, quoted } = await readyForm();
    await flip();
    const refusal = async (text: string, line: string) => {
      await paste(text);
      expect(form.current.error?.line, line).toBe(line);
      expect(form.current.lnInvoiceInvalid).toBe(true);
      expect(form.current.primary).toEqual({ label: "Paste your Lightning invoice", action: "focus-ln-invoice", disabled: false });
      expect(form.current.plan).toBeNull();
    };
    await refusal(amountlessInvoice(), LN_WALLET_MESSAGE.INVOICE_NO_AMOUNT);
    await refusal(visitorInvoice(2_475, { network: "mainnet" }), "This is a mainnet invoice. Use one on Bitcoin signet.");
    await refusal(visitorInvoice(2_475, { timestamp: Math.floor(Date.now() / 1000) - 700 }), LN_WALLET_MESSAGE.INVOICE_EXPIRED);
    await refusal("not an invoice", LN_WALLET_MESSAGE.INVOICE_NOT_LIGHTNING);
    await pass(QUOTE_WAIT_MS / 2);
    expect(hub.count("POST /v1/quotes")).toBe(0);

    // Valid now, but it expires 60 s from now and the quote holds for 150 s: refused once the quote says so.
    await paste(visitorInvoice(2_475, { expirySeconds: 60 }));
    await quoted();
    expect(form.current.error?.line).toBe(LN_WALLET_MESSAGE.INVOICE_EXPIRES_TOO_SOON);
    expect(form.current.primary.label).toBe("Paste your Lightning invoice");
    expect(form.current.plan).toBeNull();
  });

  test("CKB to BTC: an invoice for fewer sats than the minimum is refused in the page, before any quote", async () => {
    const { form, flip, paste } = await readyForm();
    await flip();
    await paste(visitorInvoice(500));
    expect(form.current.primary).toEqual({ label: "Min 1,000 sats", action: "none", disabled: true });
    await pass(QUOTE_WAIT_MS / 2);
    expect(hub.count("POST /v1/quotes")).toBe(0);
  });

  test("while the quote loads: Getting quote…", async () => {
    const { form, type, quoted } = await readyForm();
    await type("2000");
    expect(form.current.primary).toEqual({ label: "Getting quote…", action: "none", disabled: true });
    await quoted();
  });

  test("an expired quote: Refresh quote asks the hub for a new one", async () => {
    const { form, props, type, quoted } = await readyForm();
    await type("2000");
    await quoted();
    const first = form.current.quote!;
    await form.rerender({ ...props, nowMs: Date.parse(first.expiresAt) });
    expect(form.current.primary).toEqual({ label: "Refresh quote", action: "refresh-quote", disabled: false });
    expect(form.current.plan).toBeNull();

    await act(async () => form.current.quoteState.refresh());
    await form.rerender({ ...props, nowMs: Date.now() });
    await until(() => form.current.quote !== null && form.current.quote.id !== first.id, "a new quote", QUOTE_WAIT_MS);
    expect(hub.count("POST /v1/quotes")).toBe(2);
    expect(form.current.primary.label).toBe("Swap");
  });

  test("ready: Swap, with the quote on the card as the plan", async () => {
    const { form, type, quoted } = await readyForm();
    await type("2000");
    await quoted();
    expect(form.current.primary).toEqual({ label: "Swap", action: "swap", disabled: false });
    expect(form.current.plan).toEqual({ quote: form.current.quote, symbol: "CKB", payoutInvoice: null });
    // 2,000 sats at $80,000 per BTC and $0.002 per CKB, less 1%.
    expect(form.current.receiveFigure).toBe("792");
  });

  test("a Fiber token is typed in its own units and quoted on the pay side in its base units", async () => {
    hub.assets = [hubAsset("CKB"), hubAsset("RUSD", { decimals: 6 })];
    const { form, type, flip, quoted } = await readyForm();
    await flip();
    await act(async () => form.current.setAsset("RUSD"));
    await type(`12${mark}5`);
    await quoted();
    expect(hub.bodies("POST /v1/quotes")).toEqual([{ direction: "fiber_to_ln", asset: "RUSD", side: "pay", amount: "12500000" }]);
    expect(form.current.quote?.asset).toBe("RUSD");
  });

  test("a Fiber amount the hub refuses names the limit it crossed, from the prices of an earlier quote", async () => {
    const { form, type, flip, quoted } = await readyForm();
    await flip();
    await type("1000");
    await quoted();
    // 10 CKB is worth 24 sats, under the 1,000 sats minimum.
    await type("10");
    await until(() => form.current.quoteState.error !== null, "the hub's refusal", QUOTE_WAIT_MS);
    expect(form.current.primary).toEqual({ label: "Min 1,000 sats", action: "none", disabled: true });
  });

  test("a refused Fiber amount with no earlier prices says the range", async () => {
    const { form, type, flip } = await readyForm();
    await flip();
    await type("10");
    await until(() => form.current.quoteState.error !== null, "the hub's refusal", QUOTE_WAIT_MS);
    expect(form.current.primary.disabled).toBe(true);
    expect(form.current.plan).toBeNull();
    expect(form.current.error?.line).toBe(CARD_ERROR.RANGE("1,000", "20,000"));
  });

  test("the flip makes what was received the amount paid, and quotes it the other way", async () => {
    const { form, type, flip, quoted } = await readyForm();
    await type("2000");
    await quoted();
    await flip();
    expect(form.current.direction).toBe("fiber_to_ln");
    expect(form.current.amountText).toBe("792");
    await until(() => hub.count("POST /v1/quotes") === 2, "the flipped quote", QUOTE_WAIT_MS);
    expect(hub.bodies("POST /v1/quotes")[1]).toEqual({ direction: "fiber_to_ln", asset: "CKB", side: "pay", amount: CKB(792) });
  });

  test("a run that ended forgets the spent invoices and quotes again", async () => {
    const { form, flip, paste, quoted } = await readyForm();
    await flip();
    await paste(visitorInvoice(2_475));
    await quoted();
    await act(async () => form.current.renew());
    expect(form.current.lnInvoiceText).toBe("");
    expect(form.current.amountFixed).toBe(false);
  });
});

/* =============================================================================================== the run */

interface RunnerProps {
  fiber: FiberWalletApi;
  nowMs: number;
}

/** A plan as the card makes it: CKB or RUSD to BTC carries the visitor's invoice for exactly the quote's sats. */
const plan = (quote: QuoteDto, payoutInvoice: string | null = quote.direction === "fiber_to_ln" ? visitorInvoice(quote.receive.amount) : null): SwapPlan => ({
  quote,
  symbol: quote.asset,
  payoutInvoice,
});

async function renderRunner(hub: FakeHub, webln: WeblnPayStore, props: RunnerProps) {
  return renderHook((p: RunnerProps) => useSwapRunner({ fiber: p.fiber, health: HEALTH, nowMs: p.nowMs, webln }), props, withHub(hub));
}

const statuses = (run: SwapRun | null) => run?.steps.map((s) => s.status);
const step = (run: SwapRun | null, n: number) => run?.steps[n - 1];

const BTC_TO_CKB: CreateQuoteBody = { direction: "ln_to_fiber", asset: "CKB", side: "pay", amount: "2000" };
const CKB_TO_BTC: CreateQuoteBody = { direction: "fiber_to_ln", asset: "CKB", side: "receive", amount: "2475" };

test.describe("the run", () => {
  let hub: FakeHub;
  let webln: FakeWebln;

  test.beforeEach(() => {
    hub = new FakeHub();
    webln = new FakeWebln();
  });

  test.afterEach(() => {
    expect(hub.offContract, "requests outside the hub's REST contract").toEqual([]);
    // The demo wallet is never used: no swap is created as a demo.
    for (const body of hub.bodies("POST /v1/swaps")) expect(body).not.toHaveProperty("demo");
  });

  /** A runner with a quote; script the wallets, then `start()` is the click on Swap. `browserWallet`: WebLN on the page. */
  async function newRun(body: CreateQuoteBody, fiberState: FiberWalletState, browserWallet = false) {
    const fiber = new FakeFiberWallet(fiberState);
    const quote = hub.issueQuote(body);
    const props: RunnerProps = { fiber: fiber.api, nowMs: Date.now() };
    const runner = await renderRunner(hub, webln.store(browserWallet), props);
    const start = (payoutInvoice?: string | null) => act(async () => runner.current.start(plan(quote, payoutInvoice)));
    const payInBrowser = () => act(async () => runner.current.payInBrowser());
    return { runner, fiber, quote, props, start, payInBrowser, run: () => runner.current.run };
  }

  async function startRun(body: CreateQuoteBody, fiberState: FiberWalletState, o: { payoutInvoice?: string | null; browserWallet?: boolean } = {}) {
    const ready = await newRun(body, fiberState, o.browserWallet);
    await ready.start(o.payoutInvoice);
    return ready;
  }

  const holdShown = (run: () => SwapRun | null) => until(() => typeof run()?.manualInvoice === "string", "the hold invoice to pay");

  test("BTC to CKB: the node's invoice and the swap by themselves, then the hub's hold invoice for the visitor to pay", async () => {
    const { fiber, quote, run } = await startRun(BTC_TO_CKB, BROWSER_NODE);
    await holdShown(run);
    expect(fiber.made).toHaveLength(1);
    expect(hub.bodies("POST /v1/swaps")).toEqual([{ quoteId: quote.id, payoutInvoice: hub.swap.receive.invoice }]);
    expect(run()?.manualInvoice).toBe(hub.swap.pay.invoice);
    expect(step(run(), 3)).toMatchObject({ status: "active", title: "Pay from your Lightning wallet", line: "Pay the invoice below" });
    // No browser wallet on the page: only the QR code, Copy and Open in wallet.
    expect(run()?.browserWallet).toBeNull();
    expect(run()?.retry).toBeNull();

    hub.advance({ state: "incoming_accepted" }, SWAP_EVENT.INCOMING_ACCEPTED);
    await until(() => run()?.swap?.state === "incoming_accepted", "the hub to hold the payment", POLL_WAIT_MS);
    expect(run()?.manualInvoice).toBeNull();
    expect(statuses(run())).toEqual(["done", "done", "done", "active", "pending"]);
    expect(webln.paid).toEqual([]);
  });

  test("own node, BTC to Fiber: the pasted invoice is step 1, and the visitor pays the hold invoice", async () => {
    const pasted = demoFiberInvoice("testnet", BigInt(CKB(792)));
    const { fiber, quote, run } = await startRun(BTC_TO_CKB, OWN_NODE, { payoutInvoice: pasted });
    await holdShown(run);
    expect(fiber.made).toEqual([]);
    expect(step(run(), 1)).toMatchObject({ status: "done", line: STEP_LINE.INVOICE_PASTED });
    expect(hub.bodies("POST /v1/swaps")).toEqual([{ quoteId: quote.id, payoutInvoice: pasted }]);
    expect(run()?.manualInvoice).toMatch(/^lntbs/);
  });

  test("CKB to BTC: the visitor's pasted invoice is step 1 (Your invoice), the node pays the hold invoice once", async () => {
    const invoice = visitorInvoice(2_475);
    const { fiber, quote, run } = await startRun(CKB_TO_BTC, BROWSER_NODE, { payoutInvoice: invoice });
    await until(() => fiber.paid.length === 1, "the node's payment");
    expect(step(run(), 1)).toMatchObject({ status: "done", title: "Your invoice", line: STEP_LINE.INVOICE_PASTED });
    expect(hub.bodies("POST /v1/swaps")).toEqual([{ quoteId: quote.id, payoutInvoice: invoice }]);
    expect(fiber.paid).toEqual([{ swapId: hub.swap.id, invoice: hub.swap.pay.invoice }]);
    await until(() => step(run(), 3)?.line === STEP_LINE.SENT, "the payment to count as sent");
    expect(run()?.manualInvoice).toBeNull();
  });

  test("CKB to BTC without a pasted invoice: step 1 asks for it, and no swap is created", async () => {
    const { run } = await startRun(CKB_TO_BTC, BROWSER_NODE, { payoutInvoice: null });
    await until(() => step(run(), 1)?.status === "failed", "step 1 to fail");
    expect(step(run(), 1)?.line).toBe(RUN_ERROR.LN_PASTE_INVOICE);
    await pass(200);
    expect(hub.count("POST /v1/swaps")).toBe(0);
  });

  test("own node, Fiber to BTC: the hold invoice is shown to pay by hand, and the hub's state moves the run on", async () => {
    const { fiber, run } = await startRun(CKB_TO_BTC, OWN_NODE);
    await holdShown(run);
    expect(run()?.manualInvoice).toBe(hub.swap.pay.invoice);
    expect(run()?.manualInvoice).toMatch(/^fibt/);
    expect(fiber.paid).toEqual([{ swapId: hub.swap.id, invoice: hub.swap.pay.invoice }]);
    expect(step(run(), 3)).toMatchObject({ status: "active", line: STEP_LINE.MANUAL.fiber_to_ln });
    expect(run()?.retry).toBeNull();
    expect(run()?.browserWallet).toBeNull();

    hub.advance({ state: "incoming_accepted" }, SWAP_EVENT.INCOMING_ACCEPTED);
    await until(() => run()?.swap?.state === "incoming_accepted", "the hub's next state", POLL_WAIT_MS);
    expect(run()?.manualInvoice).toBeNull();
    expect(statuses(run())).toEqual(["done", "done", "done", "active", "pending"]);
  });

  test("an expired quote takes the hold invoice off the screen, either way", async () => {
    for (const body of [CKB_TO_BTC, BTC_TO_CKB]) {
      const { runner, props, run } = await startRun(body, OWN_NODE, { payoutInvoice: body === BTC_TO_CKB ? demoFiberInvoice("testnet", BigInt(CKB(792))) : undefined });
      await holdShown(run);
      await runner.rerender({ ...props, nowMs: Date.parse(hub.swap.quoteExpiresAt) });
      expect(run()?.manualInvoice, body.direction).toBeNull();
      expect(step(run(), 3), body.direction).toMatchObject({ status: "failed", line: STEP_LINE.EXPIRED });
      hub = new FakeHub();
    }
  });

  test("own node, BTC to Fiber, nothing pasted: step 1 asks for the invoice, and no swap is created", async () => {
    const { run } = await startRun(BTC_TO_CKB, OWN_NODE);
    await until(() => step(run(), 1)?.status === "failed", "step 1 to fail");
    expect(step(run(), 1)?.line).toBe(RUN_ERROR.FIBER_PASTE_INVOICE);
    await pass(200);
    expect(hub.count("POST /v1/swaps")).toBe(0);
    expect(run()?.retry).toBe("make-invoice");
    expect(isRunSettled(run()!)).toBe(true);
  });

  test("a failed payout ends in a refund, with the hub's reason", async () => {
    const { run } = await startRun(BTC_TO_CKB, BROWSER_NODE);
    await holdShown(run);
    hub.advance({ state: "failed", failureReason: "No route to your node." }, SWAP_EVENT.INCOMING_ACCEPTED, SWAP_EVENT.PAYOUT_STARTED, SWAP_EVENT.PAYOUT_FAILED);
    await until(() => run()?.outcome === "refund-pending", "the refund to start", POLL_WAIT_MS);
    expect(run()?.final).toBe(false);
    expect(statuses(run())).toEqual(["done", "done", "done", "failed", "failed"]);

    hub.advance({ refunded: true }, SWAP_EVENT.CANCELLED);
    await until(() => run()?.outcome === "refunded", "the refund", POLL_WAIT_MS);
    expect(run()?.final).toBe(true);
    expect(run()?.swap?.failureReason).toBe("No route to your node.");
    expect(run()?.retry).toBeNull();
  });

  test("cancelled with nothing paid: Swap cancelled, and Try again starts over with a new quote", async () => {
    const { runner, props, run } = await startRun(BTC_TO_CKB, BROWSER_NODE);
    await holdShown(run);
    await runner.rerender({ ...props, nowMs: Date.parse(hub.swap.quoteExpiresAt) });
    expect(run()?.retry).toBeNull();

    hub.advance({ state: "failed", refunded: true, failureReason: "The quote expired." }, SWAP_EVENT.EXPIRED, SWAP_EVENT.CANCELLED);
    await until(() => run()?.outcome === "cancelled", "the hub's cancel", POLL_WAIT_MS);
    expect(step(run(), 5)).toMatchObject({ status: "failed", line: STEP_LINE.CANCELLED });
    expect(run()?.retry).toBe("new-quote");
    expect(isRunSettled(run()!)).toBe(true);
  });

  test("the browser wallet pays the hold invoice when asked, once per click; a refusal may be asked again", async () => {
    webln.payAnswers.push(weblnRefusal());
    const { runner, run, payInBrowser } = await startRun(BTC_TO_CKB, BROWSER_NODE, { browserWallet: true });
    await holdShown(run);
    // Nothing is paid until the visitor asks.
    await pass(300);
    expect(webln.paid).toEqual([]);
    expect(run()?.browserWallet).toEqual({ error: null });

    await payInBrowser();
    await until(() => run()?.browserWallet?.error !== null && run()?.browserWallet?.error !== undefined, "the refusal");
    expect(run()?.browserWallet?.error).toEqual({ line: RUN_ERROR.WALLET_DECLINED, detail: "User rejected." });
    // Still payable, by QR code or by the browser wallet again.
    expect(run()?.manualInvoice).toBe(hub.swap.pay.invoice);
    expect(step(run(), 3)).toMatchObject({ status: "active", line: "Pay the invoice below" });

    // A fast double click, then a late third one.
    await act(async () => {
      runner.current.payInBrowser();
      runner.current.payInBrowser();
    });
    await until(() => webln.paid.length === 2, "the second payment");
    await payInBrowser();
    await pass(300);
    expect(webln.paid).toEqual([hub.swap.pay.invoice, hub.swap.pay.invoice]);
    expect(webln.enables).toBe(2);
    expect(step(run(), 3)).toMatchObject({ status: "active", line: STEP_LINE.SENT });
    expect(run()?.manualInvoice).toBeNull();
    expect(run()?.browserWallet).toBeNull();
  });

  test("a browser wallet with no clear answer counts as sent and is never asked again", async () => {
    webln.payAnswers.push(weblnSilence);
    const { runner, run, payInBrowser } = await startRun(BTC_TO_CKB, BROWSER_NODE, { browserWallet: true });
    await holdShown(run);
    await payInBrowser();
    await until(() => step(run(), 3)?.line === STEP_LINE.SENT, "the payment to count as sent");
    expect(run()?.manualInvoice).toBeNull();
    for (let i = 0; i < 3; i++) await act(async () => runner.current.payInBrowser());
    await pass(300);
    expect(webln.paid).toHaveLength(1);

    hub.advance({ state: "incoming_accepted" }, SWAP_EVENT.INCOMING_ACCEPTED);
    await until(() => step(run(), 3)?.status === "done", "the hub to hold the payment", POLL_WAIT_MS);
    expect(webln.paid).toHaveLength(1);
  });

  test("a browser wallet with no route to the hub says so, pointing to a channel from the hub", async () => {
    webln.payAnswers.push(weblnRefusal("Failed to send payment: RouteNotFound. User rejected"));
    const { run, payInBrowser } = await startRun(BTC_TO_CKB, BROWSER_NODE, { browserWallet: true });
    await holdShown(run);
    await payInBrowser();
    await until(() => !!run()?.browserWallet?.error, "the refusal");
    expect(run()?.browserWallet?.error).toEqual({
      line: RUN_ERROR.NO_ROUTE,
      detail: "Failed to send payment: RouteNotFound. User rejected.",
      help: "lightning-channel",
    });
  });

  test("a hold invoice that does not match the swap is never shown or paid", async () => {
    hub.holdInvoice = (swap) => lightningInvoice({ sats: Number(swap.pay.amount) + 1 });
    const { runner, run } = await startRun(BTC_TO_CKB, BROWSER_NODE, { browserWallet: true });
    await until(() => step(run(), 3)?.status === "failed", "the hold invoice check");
    expect(step(run(), 3)?.line).toBe(LN_WALLET_MESSAGE.HOLD_INVOICE_MISMATCH);
    expect(run()?.manualInvoice).toBeNull();
    expect(run()?.browserWallet).toBeNull();
    await act(async () => runner.current.payInBrowser());
    await pass(300);
    expect(webln.paid).toEqual([]);
    expect(run()?.retry).toBeNull();
  });

  test("a Fiber payment the node refused may be tried again; the second one is sent", async () => {
    const { runner, fiber, run, start } = await newRun(CKB_TO_BTC, BROWSER_NODE);
    fiber.payAnswers.push(() => Promise.reject(new BridgeError(BRIDGE_ERROR.NO_OUTBOUND, "Your node can send 100 CKB; this swap needs 1,000 CKB.")));
    await start();
    await until(() => step(run(), 3)?.status === "failed", "the refused payment");
    expect(step(run(), 3)).toMatchObject({ line: RUN_ERROR.NODE_NO_OUTBOUND, detail: "Your node can send 100 CKB; this swap needs 1,000 CKB." });
    expect(run()?.retry).toBe("pay");

    await act(async () => {
      runner.current.retry();
      runner.current.retry();
    });
    await until(() => step(run(), 3)?.line === STEP_LINE.SENT, "the second payment");
    expect(fiber.paid).toEqual([
      { swapId: hub.swap.id, invoice: hub.swap.pay.invoice },
      { swapId: hub.swap.id, invoice: hub.swap.pay.invoice },
    ]);
  });

  test("a Fiber payment the node did not answer in time counts as sent, and is not offered again", async () => {
    const { runner, fiber, run, start } = await newRun(CKB_TO_BTC, BROWSER_NODE);
    fiber.payAnswers.push(() => Promise.reject(new BridgeError(BRIDGE_ERROR.TIMEOUT, "Your Fiber node did not answer in time.")));
    await start();
    await until(() => fiber.paid.length === 1 && step(run(), 3)?.line === STEP_LINE.SENT, "the payment to count as sent");
    expect(run()?.retry).toBeNull();
    await act(async () => runner.current.retry());
    await pass(300);
    expect(fiber.paid).toHaveLength(1);
  });

  test("a hub that did not answer is asked again with the same quote and invoice, once per click", async () => {
    hub.swapFaults.push({ status: 503, code: HUB_PROXY_ERROR_CODE.HUB_UNAVAILABLE, message: "The hub cannot be reached." });
    const { runner, run } = await startRun(BTC_TO_CKB, BROWSER_NODE);
    await until(() => step(run(), 2)?.status === "failed", "the failed request");
    expect(step(run(), 2)?.line).toBe(RUN_ERROR.HUB_UNREACHABLE);
    expect(run()?.retry).toBe("create-swap");
    expect(isRunSettled(run()!)).toBe(true);

    await act(async () => {
      runner.current.retry();
      runner.current.retry();
    });
    await holdShown(run);
    const [first, second, ...more] = hub.bodies("POST /v1/swaps");
    expect(more).toEqual([]);
    expect(second).toEqual(first);
  });

  for (const [name, fault] of [
    ["already has a swap", { status: 409, code: API_ERROR_CODE.CONFLICT, message: "Taken." }],
    ["expired at the hub", { status: 410, code: API_ERROR_CODE.QUOTE_EXPIRED, message: "The quote expired." }],
  ] as const) {
    test(`a quote that ${name} needs a new one: nothing is sent again`, async () => {
      hub.swapFaults.push(fault);
      const { runner, run } = await startRun(CKB_TO_BTC, BROWSER_NODE);
      await until(() => step(run(), 2)?.status === "failed", "the refused swap");
      expect(run()?.retry).toBe("new-quote");
      expect(isRunSettled(run()!)).toBe(true);
      await act(async () => runner.current.retry());
      await pass(300);
      expect(hub.count("POST /v1/swaps")).toBe(1);
    });
  }

  test("a quote that expires before the swap is created is never locked or paid, and offers a new quote", async () => {
    const slow = deferred<string>();
    const { runner, props, fiber, quote, start, run } = await newRun(BTC_TO_CKB, BROWSER_NODE);
    fiber.makeAnswers.push(() => slow.promise);
    await start();
    await until(() => fiber.made.length === 1, "the payout invoice request");
    await runner.rerender({ ...props, nowMs: Date.parse(quote.expiresAt) });
    slow.resolve(demoFiberInvoice("testnet", BigInt(quote.receive.amount)));
    await pass(500);
    expect(hub.count("POST /v1/swaps")).toBe(0);
    // Nothing more happens by itself, so the visitor must be able to start over (the dialog cannot be closed until then).
    expect({ retry: run()?.retry, settled: isRunSettled(run()!) }).toEqual({ retry: "new-quote", settled: true });
  });

  test("a run put away drops its node's late answer: no swap is created for it", async () => {
    const slow = deferred<string>();
    const { runner, fiber, quote, start } = await newRun(BTC_TO_CKB, BROWSER_NODE);
    fiber.makeAnswers.push(() => slow.promise);
    await start();
    await until(() => fiber.made.length === 1, "the payout invoice request");
    await act(async () => runner.current.reset());
    slow.resolve(demoFiberInvoice("testnet", BigInt(quote.receive.amount)));
    await pass(300);
    expect(runner.current.run).toBeNull();
    expect(hub.count("POST /v1/swaps")).toBe(0);
  });

  test("the swap's cancel token is never part of the run: the card and Pay give no receiver, so it is dropped", async () => {
    const { run } = await startRun(BTC_TO_CKB, BROWSER_NODE);
    await holdShown(run);
    const token = hub.cancelTokens.get(hub.swap.id)!;
    expect(run()?.swap).not.toHaveProperty("cancelToken");
    expect(JSON.stringify(run())).not.toContain(token);
    expect(hub.count("POST /v1/swaps/:id/cancel")).toBe(0);
  });

  test("with a receiver, each swap's token goes to it once, with whether the run still follows that swap", async () => {
    const received: [string, string, boolean][] = [];
    const fiber = new FakeFiberWallet(BROWSER_NODE);
    const runner = await renderHook(
      (p: RunnerProps) =>
        useSwapRunner({ fiber: p.fiber, health: HEALTH, nowMs: p.nowMs, webln: webln.store(false), onCancelToken: (...args) => received.push(args) }),
      { fiber: fiber.api, nowMs: Date.now() },
      withHub(hub),
    );
    await act(async () => runner.current.start(plan(hub.issueQuote(BTC_TO_CKB))));
    await holdShown(() => runner.current.run);
    expect(received).toEqual([[hub.swap.id, hub.cancelTokens.get(hub.swap.id), true]]);
    expect(JSON.stringify(runner.current.run)).not.toContain(hub.cancelTokens.get(hub.swap.id));

    // A swap the hub creates after the run was put away: its token still arrives, marked as no longer followed.
    const gate = deferred<void>();
    hub.swapGate = gate.promise;
    await act(async () => runner.current.start(plan(hub.issueQuote(BTC_TO_CKB))));
    await until(() => hub.count("POST /v1/swaps") === 2, "the second POST /v1/swaps");
    await act(async () => runner.current.reset());
    gate.resolve();
    await until(() => received.length === 2, "the second token");
    expect(received[1]).toEqual([hub.lastSwap.id, hub.cancelTokens.get(hub.lastSwap.id), false]);
    expect(runner.current.run).toBeNull();
  });
});

/* ===================================================================== Get paid's Lightning invoice */

interface LightningProps {
  fiber: FiberWalletApi;
  nowMs: number;
}

/** A Get paid request for 1,000 CKB, as RequestPanel opens it. */
const OPEN_REQUEST: OpenRequest = { id: "8a0d9c41-6f2e-4b7a-9c3d-2e1f0a9b8c7d", asset: "CKB", units: CKB(1_000), symbol: "CKB", decimals: 8, note: null };

test.describe("Get paid's Lightning invoice (the real useLightningInvoice): made on demand, cancelled at the hub once not needed", () => {
  let hub: FakeHub;
  let fiber: FakeFiberWallet;
  let warnings: string[];

  test.beforeEach(() => {
    hub = new FakeHub();
    fiber = new FakeFiberWallet(BROWSER_NODE);
    warnings = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    cleanups.push(() => {
      console.warn = warn;
    });
  });

  test.afterEach(() => {
    expect(hub.offContract, "requests outside the hub's REST contract").toEqual([]);
    // The token went only to the hub's cancel route, never into a log line.
    for (const token of hub.cancelTokens.values()) expect(warnings.join("\n")).not.toContain(token);
  });

  async function renderLightning() {
    const lightning = await renderHook(
      (p: LightningProps) => useLightningInvoice({ fiber: p.fiber, health: HEALTH, nowMs: p.nowMs }),
      { fiber: fiber.api, nowMs: Date.now() },
      withHub(hub),
    );
    const renew = () => act(async () => lightning.current.renew(OPEN_REQUEST));
    const waiting = () => until(() => lightning.current.part.status === "waiting", "the Lightning invoice to pay");
    return { lightning, renew, waiting };
  }

  test("nothing is asked of the hub until it is wanted; then a request quote, the node's payout invoice for the request, the swap", async () => {
    const { lightning, renew, waiting } = await renderLightning();
    expect(lightning.current.part.status).toBe("idle");
    await pass(200);
    expect(hub.requests).toEqual([]);

    await renew();
    await waiting();
    expect(hub.bodies("POST /v1/quotes")).toEqual([{ direction: "ln_to_fiber", asset: "CKB", side: "receive", amount: CKB(1_000), purpose: "request" }]);
    expect(fiber.made).toEqual([expect.objectContaining({ asset: "CKB", amount: CKB(1_000), request: OPEN_REQUEST.id })]);
    expect(lightning.current.part).toMatchObject({ invoice: hub.swap.pay.invoice, sats: hub.swap.pay.amount });
    expect(JSON.stringify(lightning.current)).not.toContain(hub.cancelTokens.get(hub.swap.id));
    expect(hub.count("POST /v1/swaps/:id/cancel")).toBe(0);
  });

  test("paid on Fiber (release): the unpaid swap is cancelled with its own token, once; the page follows it to Cancelled", async () => {
    const { lightning, renew, waiting } = await renderLightning();
    await renew();
    await waiting();
    const { id } = hub.swap;
    await act(async () => lightning.current.release());
    await until(() => hub.cancels.length === 1, "the cancel");
    expect(hub.cancels).toEqual([{ id, token: hub.cancelTokens.get(id), status: 200 }]);
    await until(() => lightning.current.part.status === "cancelled", "the cancelled swap", POLL_WAIT_MS);
    await act(async () => lightning.current.release());
    await act(async () => lightning.current.reset());
    await pass(200);
    expect(hub.cancels).toHaveLength(1);
  });

  test("New invoice cancels the unpaid one before it makes another; New request cancels the current one and forgets it", async () => {
    const { lightning, renew, waiting } = await renderLightning();
    await renew();
    await waiting();
    const first = hub.lastSwap.id;
    await renew();
    await until(() => hub.count("POST /v1/swaps") === 2 && lightning.current.part.status === "waiting", "the second invoice");
    const second = hub.lastSwap.id;
    expect(second).not.toBe(first);
    expect(lightning.current.part.invoice).toBe(hub.lastSwap.pay.invoice);
    expect(hub.cancels).toEqual([{ id: first, token: hub.cancelTokens.get(first), status: 200 }]);

    await act(async () => lightning.current.reset());
    await until(() => hub.cancels.length === 2, "the second cancel");
    expect(hub.cancels[1]).toEqual({ id: second, token: hub.cancelTokens.get(second), status: 200 });
    expect(lightning.current.part.status).toBe("idle");
  });

  test("a swap whose payment is held is never cancelled: the payer who paid both shows as Paid twice", async () => {
    const { lightning, renew, waiting } = await renderLightning();
    await renew();
    await waiting();
    hub.advance({ state: "incoming_accepted" }, SWAP_EVENT.INCOMING_ACCEPTED);
    await until(() => lightning.current.part.status === "arriving", "the held payment", POLL_WAIT_MS);
    await act(async () => lightning.current.release());
    await act(async () => lightning.current.reset());
    await pass(200);
    expect(hub.count("POST /v1/swaps/:id/cancel")).toBe(0);
  });

  test("a cancel the hub cannot do is only logged, by the swap's id", async () => {
    hub.cancelFaults.push({ status: 503, code: API_ERROR_CODE.UPSTREAM_UNAVAILABLE, message: "The Lightning node did not answer." });
    const { lightning, renew, waiting } = await renderLightning();
    await renew();
    await waiting();
    await act(async () => lightning.current.release());
    await until(() => warnings.length === 1, "the warning");
    expect(warnings[0]).toBe(`[ckbolt get paid] The hub did not cancel swap ${hub.swap.id}: The Lightning node did not answer.`);
    expect(lightning.current.part.status).toBe("waiting");
  });

  test("a swap the hub creates after the request was put away, or after it was paid, is cancelled as soon as it arrives", async () => {
    const { lightning, renew } = await renderLightning();
    for (const [what, end] of [
      ["New request", () => lightning.current.reset()],
      ["paid on Fiber", () => lightning.current.release()],
    ] as const) {
      const gate = deferred<void>();
      hub.swapGate = gate.promise;
      const before = hub.count("POST /v1/swaps");
      await renew();
      await until(() => hub.count("POST /v1/swaps") === before + 1, `the POST /v1/swaps (${what})`);
      await act(async () => end());
      gate.resolve();
      await until(() => hub.cancels.length === before + 1, `the cancel (${what})`);
      expect(hub.cancels.at(-1)).toEqual({ id: hub.lastSwap.id, token: hub.cancelTokens.get(hub.lastSwap.id), status: 200 });
    }
  });
});

/* ===================================================================== the run end to end, browser node */

interface LiveProps {
  nowMs: number;
}

/** The card's wiring without its markup: the Fiber wallet controller over the bridge, and the runner. */
async function renderLiveSwap(hub: FakeHub, webln: WeblnPayStore) {
  bridgeUsed = true;
  return renderHook(
    (p: LiveProps) => {
      const fiber = useFiberWalletController(HEALTH.fiber.network, false).api;
      const runner = useSwapRunner({ fiber, health: HEALTH, nowMs: p.nowMs, webln });
      return { fiber, runner };
    },
    { nowMs: Date.now() },
    withHub(hub),
  );
}

test.describe("the run end to end with the browser node", () => {
  let hub: FakeHub;
  let webln: FakeWebln;
  let tab: FakeNodeTab;

  test.beforeEach(() => {
    hub = new FakeHub();
    webln = new FakeWebln();
    tab = new FakeNodeTab();
  });

  async function connected() {
    const live = await renderLiveSwap(hub, webln.store());
    await act(async () => live.current.fiber.choose("browser-node"));
    await until(() => live.current.fiber.ready, "the browser node", STATUS_WAIT_MS);
    return { live, run: () => live.current.runner.run };
  }

  test("BTC to CKB from one click: node invoice, swap, the browser wallet pays once, payout, complete", async () => {
    const { live, run } = await connected();
    const quote = hub.issueQuote(BTC_TO_CKB);
    await act(async () => live.current.runner.start(plan(quote)));
    await until(() => typeof run()?.manualInvoice === "string", "the hold invoice to pay");

    // 1: the node made the payout invoice for exactly what the quote pays out.
    expect(tab.calls(BRIDGE_METHOD.MAKE_INVOICE)).toEqual([{ asset: "CKB", amount: quote.receive.amount, quoteExpiresAt: quote.expiresAt, network: "testnet" }]);
    // 2: one swap with that invoice.
    expect(hub.bodies("POST /v1/swaps")).toEqual([{ quoteId: quote.id, payoutInvoice: tab.invoices[0] }]);
    // 3: the hub's hold invoice waits for the visitor; the browser wallet pays it when asked; the node pays nothing.
    expect(statuses(run())).toEqual(["done", "done", "active", "pending", "pending"]);
    await act(async () => live.current.runner.payInBrowser());
    await until(() => step(run(), 3)?.line === STEP_LINE.SENT, "the browser wallet's payment");
    expect(webln.paid).toEqual([hub.swap.pay.invoice]);
    expect(tab.calls(BRIDGE_METHOD.PAY_INVOICE)).toEqual([]);

    // 4: the hub pays out.
    hub.advance({ state: "outgoing_in_flight" }, SWAP_EVENT.INCOMING_ACCEPTED, SWAP_EVENT.PAYOUT_STARTED);
    await until(() => run()?.swap?.state === "outgoing_in_flight", "the payout", POLL_WAIT_MS);
    expect(statuses(run())).toEqual(["done", "done", "done", "active", "pending"]);

    // 5: complete, with the preimage.
    hub.succeed();
    await until(() => run()?.final === true, "the end of the swap", POLL_WAIT_MS);
    expect(statuses(run())).toEqual(["done", "done", "done", "done", "done"]);
    expect(run()?.outcome).toBe("complete");
    expect(run()?.retry).toBeNull();
    expect(run()?.swap?.preimage).toBe(hub.preimageOf(hub.swap));
    expect(createHash("sha256").update(Buffer.from(run()!.swap!.preimage!, "hex")).digest("hex")).toBe(run()?.swap?.paymentHash);
    expect(webln.paid).toHaveLength(1);
    expect(hub.count("POST /v1/swaps")).toBe(1);
  });

  test("CKB to BTC from one click: the pasted invoice, swap, node payment, payout, complete", async () => {
    const { live, run } = await connected();
    const quote = hub.issueQuote(CKB_TO_BTC);
    const invoice = visitorInvoice(quote.receive.amount);
    await act(async () => live.current.runner.start(plan(quote, invoice)));
    await until(() => tab.calls(BRIDGE_METHOD.PAY_INVOICE).length === 1, "the node's payment");

    // 1: the visitor's own invoice, for exactly the quote's sats (2,475).
    expect(quote.receive.amount).toBe("2475");
    // 2: one swap with that invoice.
    expect(hub.bodies("POST /v1/swaps")).toEqual([{ quoteId: quote.id, payoutInvoice: invoice }]);
    // 3: the node paid the hub's Fiber hold invoice; no browser wallet was asked.
    expect(tab.calls(BRIDGE_METHOD.PAY_INVOICE)).toEqual([{ swapId: hub.swap.id, invoice: hub.swap.pay.invoice }]);
    expect(webln.paid).toEqual([]);
    await until(() => step(run(), 3)?.line === STEP_LINE.SENT, "the payment to count as sent");

    hub.advance({ state: "outgoing_succeeded" }, SWAP_EVENT.INCOMING_ACCEPTED, SWAP_EVENT.PAYOUT_STARTED, SWAP_EVENT.PAYOUT_SUCCEEDED);
    await until(() => run()?.swap?.state === "outgoing_succeeded", "the payout", POLL_WAIT_MS);
    expect(statuses(run())).toEqual(["done", "done", "done", "done", "active"]);
    hub.succeed();
    await until(() => run()?.outcome === "complete", "the end of the swap", POLL_WAIT_MS);
    expect(tab.calls(BRIDGE_METHOD.PAY_INVOICE)).toHaveLength(1);
  });
});

/* ======================================================================================== the Fiber wallet */

interface WalletProps {
  hubNetwork: string | null;
  watching: boolean;
}

async function renderFiberWallet(props: WalletProps = { hubNetwork: "testnet", watching: false }) {
  bridgeUsed = true;
  return renderHook((p: WalletProps) => useFiberWalletController(p.hubNetwork, p.watching), props);
}

const quoteExpiresAt = () => new Date(Date.now() + QUOTE_TTL_MS).toISOString();

test.describe("the Fiber wallet", () => {
  test("only the user's own nodes are offered: the browser node and an own node, never a demo wallet", () => {
    expect(FIBER_WALLET_KINDS).toEqual(["browser-node", "own-node"]);
  });

  test("nothing chosen: no wallet, not ready, no problem, and no node tab is asked", async () => {
    const tab = new FakeNodeTab();
    const wallet = await renderFiberWallet();
    expect(stateOf(wallet.current.api)).toEqual(NO_FIBER_WALLET);
    await pass(BRIDGE_TIMING.statusWindowMs + 200);
    expect(tab.requests).toEqual([]);
  });

  test("the browser node with no tab open: Open your Fiber node, after looking for it; the choice is remembered", async () => {
    const wallet = await renderFiberWallet();
    await act(async () => wallet.current.api.choose("browser-node"));
    expect(sandbox.sessionStorage.getItem(FIBER_WALLET_KIND_STORAGE_KEY)).toBe("browser-node");
    expect(stateOf(wallet.current.api)).toEqual({
      kind: "browser-node",
      label: "CKBolt node",
      ready: false,
      liquidity: null,
      problem: FIBER_WALLET_PROBLEM.LOOKING,
      funds: null,
    });
    await until(() => wallet.current.api.problem === "Open your Fiber node", "the empty status window", STATUS_WAIT_MS);
    expect(wallet.current.api.ready).toBe(false);
    await expect(wallet.current.api.makeInvoice({ asset: "CKB", amount: CKB(1), quoteExpiresAt: quoteExpiresAt(), network: "testnet" })).rejects.toThrow(
      "Open your Fiber node",
    );
  });

  test("a running tab connected to the hub with a channel is ready, with what it can send and receive per asset", async () => {
    const tab = new FakeNodeTab();
    tab.presence = runningPresence({ liquidity: { CKB: { send: CKB(100), receive: CKB(2_000) }, RUSD: { send: "-5", receive: "1" } } });
    const wallet = await renderFiberWallet();
    await act(async () => wallet.current.api.choose("browser-node"));
    await until(() => wallet.current.api.ready, "the node's status", STATUS_WAIT_MS);
    // Only whole base units are trusted from the bridge: the malformed RUSD entry is dropped.
    expect(stateOf(wallet.current.api)).toEqual({
      kind: "browser-node",
      label: "CKBolt node",
      ready: true,
      liquidity: { CKB: { send: CKB(100), receive: CKB(2_000) } },
      problem: null,
      funds: null,
    });
  });

  test("the tab's state is the wallet's problem, read again on each check", async () => {
    const tab = new FakeNodeTab();
    const wallet = await renderFiberWallet();
    await act(async () => wallet.current.api.choose("browser-node"));
    await until(() => wallet.current.api.ready, "the node's status", STATUS_WAIT_MS);

    const cases: [Partial<NodePresence>, string][] = [
      [{ phase: "locked" }, FIBER_WALLET_PROBLEM.LOCKED],
      [{ phase: "starting" }, FIBER_WALLET_PROBLEM.STARTING],
      [{ phase: "other-tab" }, FIBER_WALLET_PROBLEM.OTHER_TAB],
      [{ hubConnected: false }, FIBER_WALLET_PROBLEM.HUB_NOT_CONNECTED],
      [{ liquidity: { CKB: { send: "0", receive: "0" } } }, FIBER_WALLET_PROBLEM.NO_CHANNEL],
      [{ network: "devnet" }, FIBER_WALLET_PROBLEM.WRONG_NETWORK("testnet")],
    ];
    for (const [patch, problem] of cases) {
      tab.presence = runningPresence(patch);
      await act(() => wallet.current.node.check());
      expect({ ready: wallet.current.api.ready, problem: wallet.current.api.problem }, JSON.stringify(patch)).toEqual({ ready: false, problem });
    }
    tab.presence = runningPresence();
    await act(() => wallet.current.node.check());
    expect(wallet.current.api.ready).toBe(true);
  });

  test("makeInvoice asks the tab for exactly the quote's payout and returns the invoice once checked", async () => {
    const tab = new FakeNodeTab();
    const wallet = await renderFiberWallet();
    await act(async () => wallet.current.api.choose("browser-node"));
    await until(() => wallet.current.api.ready, "the node's status", STATUS_WAIT_MS);
    const request: FiberInvoiceRequest = { asset: "CKB", amount: CKB(792), quoteExpiresAt: quoteExpiresAt(), network: "testnet" };

    let invoice = "";
    await act(async () => {
      invoice = await wallet.current.api.makeInvoice(request);
    });
    expect(tab.calls(BRIDGE_METHOD.MAKE_INVOICE)).toEqual([request]);
    expect(invoice).toBe(tab.invoices[0]);

    tab.makeInvoice = (params) => ({ result: { invoice: demoFiberInvoice("testnet", BigInt(params.amount) + BigInt(1)), paymentHash: hex32() } });
    await expect(wallet.current.api.makeInvoice(request)).rejects.toThrow(FIBER_WALLET_MESSAGE.INVOICE_WRONG_AMOUNT);

    tab.makeInvoice = () => ({ error: { code: BRIDGE_ERROR.NO_INBOUND, message: "Your node cannot receive 792 CKB yet." } });
    await expect(wallet.current.api.makeInvoice(request)).rejects.toMatchObject({ code: BRIDGE_ERROR.NO_INBOUND });
  });

  test("a node that is not ready is not asked: the action fails with the reason", async () => {
    const tab = new FakeNodeTab();
    tab.presence = runningPresence({ phase: "locked" });
    const wallet = await renderFiberWallet();
    await act(async () => wallet.current.api.choose("browser-node"));
    await until(() => wallet.current.api.problem === FIBER_WALLET_PROBLEM.LOCKED, "the node's status", STATUS_WAIT_MS);
    await expect(wallet.current.api.makeInvoice({ asset: "CKB", amount: CKB(1), quoteExpiresAt: quoteExpiresAt(), network: "testnet" })).rejects.toThrow(
      FIBER_WALLET_PROBLEM.LOCKED,
    );
    await expect(wallet.current.api.payInvoice({ swapId: randomUUID(), invoice: "fibt1hold" })).rejects.toThrow(FIBER_WALLET_PROBLEM.LOCKED);
    expect(tab.calls(BRIDGE_METHOD.MAKE_INVOICE)).toEqual([]);
    expect(tab.calls(BRIDGE_METHOD.PAY_INVOICE)).toEqual([]);
  });

  test("payInvoice pays a swap once: a refusal may be tried again, and a paid swap is never sent again", async () => {
    const tab = new FakeNodeTab();
    const wallet = await renderFiberWallet();
    await act(async () => wallet.current.api.choose("browser-node"));
    await until(() => wallet.current.api.ready, "the node's status", STATUS_WAIT_MS);
    const request = { swapId: randomUUID(), invoice: demoFiberInvoice("testnet", BigInt(CKB(1_000))) };

    tab.payInvoice = () => ({ error: { code: BRIDGE_ERROR.NO_OUTBOUND, message: "Your node can send 100 CKB." } });
    await expect(wallet.current.api.payInvoice(request)).rejects.toMatchObject({ code: BRIDGE_ERROR.NO_OUTBOUND });
    tab.payInvoice = () => ({ result: { paymentHash: hex32(), status: "Inflight" } });
    await act(() => wallet.current.api.payInvoice(request));
    await act(() => wallet.current.api.payInvoice(request));
    expect(tab.calls(BRIDGE_METHOD.PAY_INVOICE)).toEqual([request, request]);
  });

  test("own node: ready, nothing known of its channels, and both actions are the user's to do by hand", async () => {
    const tab = new FakeNodeTab();
    const wallet = await renderFiberWallet();
    await act(async () => wallet.current.api.choose("own-node"));
    expect(stateOf(wallet.current.api)).toEqual(OWN_NODE);
    expect(sandbox.sessionStorage.getItem(FIBER_WALLET_KIND_STORAGE_KEY)).toBe("own-node");
    await expect(wallet.current.api.makeInvoice({ asset: "CKB", amount: CKB(1), quoteExpiresAt: quoteExpiresAt(), network: "testnet" })).rejects.toBeInstanceOf(
      ManualFiberStep,
    );
    await expect(wallet.current.api.payInvoice({ swapId: randomUUID(), invoice: "fibt1hold" })).rejects.toBeInstanceOf(ManualFiberStep);
    await pass(BRIDGE_TIMING.statusWindowMs + 200);
    expect(tab.requests).toEqual([]);
  });

  test("the choice is remembered in this tab, a value that is not a kind is ignored, and Disconnect forgets it", async () => {
    sandbox.sessionStorage.setItem(FIBER_WALLET_KIND_STORAGE_KEY, "own-node");
    const remembered = await renderFiberWallet();
    expect(remembered.current.api.kind).toBe("own-node");
    await act(async () => remembered.current.api.disconnect());
    expect(stateOf(remembered.current.api)).toEqual(NO_FIBER_WALLET);
    expect(sandbox.sessionStorage.getItem(FIBER_WALLET_KIND_STORAGE_KEY)).toBeNull();

    sandbox.sessionStorage.setItem(FIBER_WALLET_KIND_STORAGE_KEY, "demo");
    const ignored = await renderFiberWallet();
    expect(ignored.current.api.kind).toBeNull();
  });

  test("with the Fiber dialog open, the tab is asked even before a kind is chosen", async () => {
    const tab = new FakeNodeTab();
    const wallet = await renderFiberWallet({ hubNetwork: "testnet", watching: true });
    await until(() => wallet.current.node.view.presence !== null, "the node's status", STATUS_WAIT_MS);
    expect(wallet.current.node.view.presence).toEqual(tab.presence);
    expect(stateOf(wallet.current.api)).toEqual(NO_FIBER_WALLET);
  });
});
