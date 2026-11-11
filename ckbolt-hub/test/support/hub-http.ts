import "reflect-metadata";
import type { INestApplication, LogLevel } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import type { Response } from "supertest";
import { HUB_CONFIG } from "../../src/application/ports/tokens";
import { AppModule } from "../../src/app.module";
import type { ApiErrorCode } from "../../src/common/constants/api.constants";
import { SWAP_STATE } from "../../src/common/constants/swap.constants";
import type { HubConfig } from "../../src/config/hub.config";
import type { Direction, FiberAssetId } from "../../src/domain/types";
import type { CreatedSwapDto, DemoInvoiceDto, QuoteDto, SwapDto, SwapEventDto } from "../../src/interfaces/http/contract/responses";
import { pollUntil } from "./poll";

/**
 * The hub as a client sees it over HTTP, shared by the integration tests on fake nodes (test/unit/integration) and the
 * end-to-end tests on the devnet (test/e2e): the real AppModule, booted in-process and driven with supertest the way
 * the web app drives it.
 */

/* ------------------------------------------------------------------------------------------- public contract */

/** The REST API v1 paths as docs/architecture.md publishes them (spelled out: the contract is what is under test). */
export const API_PATH = {
  HEALTH: "/v1/health",
  ASSETS: "/v1/assets",
  QUOTES: "/v1/quotes",
  SWAPS: "/v1/swaps",
  DEMO_INVOICES: "/v1/demo/invoices",
  DEMO_PAYMENTS: "/v1/demo/payments",
  quote: (id: string): string => `/v1/quotes/${id}`,
  swap: (id: string): string => `/v1/swaps/${id}`,
  swapEvents: (id: string): string => `/v1/swaps/${id}/events`,
} as const;

export const LOOPBACK_HOST = "127.0.0.1";

/** How often waitForSwap reads the swap unless the caller says otherwise, ms. */
export const DEFAULT_SWAP_POLL_MS = 10;

/* ---------------------------------------------------------------------------------------------- app builders */

export type HttpClient = ReturnType<typeof request>;

export type ProviderOverride = readonly [token: symbol, value: unknown];

export interface StartHubAppOptions {
  /** Nest log levels the app prints; false (the default) silences it. */
  logger?: LogLevel[] | false;
  /** Runs on the compiled module before the app initialises (before any onModuleInit hook). */
  beforeInit?: (moduleRef: TestingModule) => void;
}

/** The real AppModule with HUB_CONFIG and the given providers replaced, listening on an ephemeral loopback port. */
export async function startHubApp(
  config: HubConfig,
  overrides: readonly ProviderOverride[],
  options: StartHubAppOptions = {},
): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] }).overrideProvider(HUB_CONFIG).useValue(config);
  for (const [token, value] of overrides) builder = builder.overrideProvider(token).useValue(value);
  const moduleRef = await builder.compile();
  options.beforeInit?.(moduleRef);
  const app = moduleRef.createNestApplication({ logger: options.logger ?? false });
  await app.listen(0, LOOPBACK_HOST);
  return app;
}

/** Anything that can open an HTTP conversation with a running hub. */
export interface HubHttp {
  http(): HttpClient;
}

/* ----------------------------------------------------------------------------------------- HTTP conversations */

export interface QuoteBody {
  direction: Direction;
  asset: FiberAssetId;
  side: "pay" | "receive";
  amount: string;
}

/** The Lightning side fixed at `sats`: what the user pays (ln_to_fiber) or receives (fiber_to_ln). */
export const lightningSideQuote = (direction: Direction, asset: FiberAssetId, sats: bigint): QuoteBody => ({
  direction,
  asset,
  side: direction === "ln_to_fiber" ? "pay" : "receive",
  amount: sats.toString(),
});

export async function postQuote(hub: HubHttp, body: QuoteBody): Promise<QuoteDto> {
  const res = await hub.http().post(API_PATH.QUOTES).send(body).expect(201);
  expect(res.headers.location).toBe(API_PATH.quote(res.body.id));
  return res.body as QuoteDto;
}

/** The demo wallet's payout invoice for the quote: it asks for exactly what the quote pays out. */
export async function postDemoInvoice(hub: HubHttp, quote: QuoteDto): Promise<DemoInvoiceDto> {
  const res = await hub.http().post(API_PATH.DEMO_INVOICES).send({ direction: quote.direction, asset: quote.asset, amount: quote.receive.amount }).expect(201);
  return res.body as DemoInvoiceDto;
}

export const postSwap = (hub: HubHttp, quoteId: string, payoutInvoice: string, demo = false): Promise<Response> =>
  hub.http().post(API_PATH.SWAPS).send({ quoteId, payoutInvoice, demo }).then((res) => res);

export async function createSwap(hub: HubHttp, quoteId: string, payoutInvoice: string, demo = false): Promise<CreatedSwapDto> {
  const res = await postSwap(hub, quoteId, payoutInvoice, demo);
  expect({ status: res.status, body: res.body }).toEqual({ status: 201, body: expect.objectContaining({ quoteId }) });
  expect(res.headers.location).toBe(API_PATH.swap(res.body.id));
  return res.body as CreatedSwapDto;
}

export async function postDemoPayment(hub: HubHttp, swapId: string): Promise<void> {
  const res = await hub.http().post(API_PATH.DEMO_PAYMENTS).send({ swapId }).expect(202);
  expect(res.body).toEqual({ swapId, status: "submitted" });
}

export async function getSwap(hub: HubHttp, id: string): Promise<SwapDto> {
  return (await hub.http().get(API_PATH.swap(id)).expect(200)).body as SwapDto;
}

export async function getEvents(hub: HubHttp, id: string): Promise<SwapEventDto[]> {
  const res = await hub.http().get(API_PATH.swapEvents(id)).expect(200);
  expect(Object.keys(res.body)).toEqual(["data"]);
  return res.body.data as SwapEventDto[];
}

/** A swap the hub is done with: succeeded, or failed with the incoming leg cancelled. */
export const isFinished = (swap: SwapDto): boolean =>
  swap.state === SWAP_STATE.SUCCEEDED || (swap.state === SWAP_STATE.FAILED && swap.refunded);

/** Polls the API in real time, without any engine pass of its own: only the scheduler moves the swap. */
export function waitForSwap(
  hub: HubHttp,
  swapId: string,
  done: (swap: SwapDto) => boolean,
  timeoutMs: number,
  intervalMs: number = DEFAULT_SWAP_POLL_MS,
): Promise<SwapDto> {
  return pollUntil(() => getSwap(hub, swapId), done, { timeoutMs, intervalMs });
}

/* -------------------------------------------------------------------------------------------- error contract */

/**
 * Checks the error contract: the status, a JSON body that is exactly `{ error: { code, message } }`, and a message that
 * is one plain sentence for people (no stack, no newline). Returns the message for further checks.
 */
export function expectApiError(res: Response, status: number, code: ApiErrorCode): string {
  expect({ status: res.status, body: res.body }).toEqual({ status, body: { error: { code, message: expect.any(String) } } });
  expect(res.headers["content-type"]).toMatch(/^application\/json/);
  const message = (res.body as { error: { message: string } }).error.message;
  expect(message).toMatch(/^[A-Z].*\.$/);
  expect(message).not.toMatch(/\n|\.[jt]s:\d+/);
  return message;
}
