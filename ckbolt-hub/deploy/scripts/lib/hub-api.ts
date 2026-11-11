import { API_ROUTES } from "../../../src/common/constants/api.constants";
import type { CreateQuoteBody, CreateSwapBody } from "../../../src/interfaces/http/contract/requests";
import {
  resourcePath,
  type AssetDto,
  type ErrorBody,
  type FiberNodeDto,
  type HealthDto,
  type ListBody,
  type QuoteDto,
  type SwapDto,
  type SwapEventDto,
} from "../../../src/interfaces/http/contract/responses";
import { HUB_CONTAINER_PORT, SERVICE } from "./constants";
import { parsePublishedAddress } from "./compose-state";
import { isSuccess } from "./http";
import type { RemoteKit } from "./kit";
import { shellJoin } from "./shell";

export interface HubResponse {
  status: number;
  /** The parsed JSON body; null when the body is empty or not JSON. */
  body: unknown;
}

/** An answer other than 2xx, with the hub's error code and sentence when it sent them. */
export class HubApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    detail: string,
  ) {
    super(`hub answered ${status}${code ? ` ${code}` : ""}: ${detail}`);
  }
}

/** curl writes the status code on a line of its own after the body. */
const STATUS_LINE_FORMAT = "\n%{http_code}";
const JSON_TYPE = "application/json";

/** Splits curl's output into the body and the status code written after it. */
export function parseCurlResponse(output: string): HubResponse {
  const cut = output.lastIndexOf("\n");
  const status = Number(output.slice(cut + 1).trim());
  const text = cut >= 0 ? output.slice(0, cut) : "";
  let body: unknown = null;
  try {
    body = text.trim() ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: Number.isInteger(status) ? status : 0, body };
}

const errorOf = (body: unknown): ErrorBody["error"] | null =>
  typeof body === "object" && body !== null && "error" in body ? (body as ErrorBody).error : null;

/**
 * The hub's REST API as the server itself reaches it: curl on the server to the port Compose publishes on 127.0.0.1
 * (the same port the operator's SSH tunnel forwards).
 */
export class HubApi {
  constructor(
    private readonly kit: RemoteKit,
    readonly baseUrl: string,
    private readonly timeoutSeconds: number,
  ) {}

  /** Finds the hub's published address; throws when the hub container does not run. */
  static async connect(kit: RemoteKit, timeoutSeconds: number): Promise<HubApi> {
    const output = await kit.compose(["port", SERVICE.HUB, String(HUB_CONTAINER_PORT)]);
    const address = parsePublishedAddress(output);
    if (!address) throw new Error(`the hub publishes no port (docker compose port ${SERVICE.HUB} ${HUB_CONTAINER_PORT}: ${output.trim()})`);
    return new HubApi(kit, `http://${address.host}:${address.port}`, timeoutSeconds);
  }

  /** One request; resolves with any status (errors of the transport throw). */
  async request(method: "GET" | "POST", path: string, body?: unknown): Promise<HubResponse> {
    const words = ["curl", "-sS", "-m", String(this.timeoutSeconds), "-X", method, "-H", `accept: ${JSON_TYPE}`];
    if (body !== undefined) words.push("-H", `content-type: ${JSON_TYPE}`, "--data-binary", "@-");
    words.push("-w", STATUS_LINE_FORMAT, `${this.baseUrl}${path}`);
    const output = await this.kit.run(shellJoin(words), {
      ...(body === undefined ? {} : { input: JSON.stringify(body) }),
      description: `${method} ${path}`,
    });
    return parseCurlResponse(output);
  }

  /** A request that must answer 2xx; returns the body. */
  async expect<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, body);
    if (isSuccess(response.status)) return response.body as T;
    const error = errorOf(response.body);
    throw new HubApiError(response.status, error?.code ?? null, error?.message ?? JSON.stringify(response.body));
  }

  /** 200 ok or 503 degraded both carry the health body. */
  async health(): Promise<{ status: number; health: HealthDto | null }> {
    const response = await this.request("GET", resourcePath(API_ROUTES.HEALTH));
    return { status: response.status, health: errorOf(response.body) ? null : (response.body as HealthDto | null) };
  }

  async assets(): Promise<AssetDto[]> {
    return (await this.expect<ListBody<AssetDto>>("GET", resourcePath(API_ROUTES.ASSETS))).data;
  }

  /** null when this hub build has no browser-node API yet (404). */
  async fiberNode(): Promise<FiberNodeDto | null> {
    const response = await this.request("GET", resourcePath(API_ROUTES.FIBER_NODE));
    if (response.status === 404) return null;
    if (response.status !== 200) throw new HubApiError(response.status, errorOf(response.body)?.code ?? null, JSON.stringify(response.body));
    return response.body as FiberNodeDto;
  }

  createQuote(body: CreateQuoteBody): Promise<QuoteDto> {
    return this.expect<QuoteDto>("POST", resourcePath(API_ROUTES.QUOTES), body);
  }

  createSwap(body: CreateSwapBody): Promise<SwapDto> {
    return this.expect<SwapDto>("POST", resourcePath(API_ROUTES.SWAPS), body);
  }

  swap(id: string): Promise<SwapDto> {
    return this.expect<SwapDto>("GET", resourcePath(API_ROUTES.SWAPS, id));
  }

  async swapEvents(id: string): Promise<SwapEventDto[]> {
    return (await this.expect<ListBody<SwapEventDto>>("GET", resourcePath(API_ROUTES.SWAPS, id, API_ROUTES.SWAP_EVENTS))).data;
  }
}
