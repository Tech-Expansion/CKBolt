import { Inject, Injectable } from "@nestjs/common";
import { HUB_CONFIG } from "../../application/ports/tokens";
import { PRICE_HTTP_HEADERS } from "../../common/constants/price-sources.constants";
import type { HubConfig } from "../../config/hub.config";
import { PriceSourceError } from "./price-source.error";

/** GETs a URL and returns its JSON body. Injected into the price sources so tests can answer without a network. */
export interface JsonHttpClient {
  getJson(url: URL): Promise<unknown>;
}

export const PRICE_HTTP_CLIENT = Symbol("PRICE_HTTP_CLIENT");

/** `base` with each of `params` set as a query parameter. */
export function buildUrl(base: string, params: Readonly<Record<string, string>>): URL {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

/** JsonHttpClient on the global fetch, aborted after `pricing.httpTimeoutMs` so a slow source cannot hang a quote. */
@Injectable()
export class FetchJsonHttpClient implements JsonHttpClient {
  constructor(@Inject(HUB_CONFIG) private readonly config: HubConfig) {}

  async getJson(url: URL): Promise<unknown> {
    const response = await fetch(url, {
      headers: PRICE_HTTP_HEADERS,
      signal: AbortSignal.timeout(this.config.pricing.httpTimeoutMs),
    });
    if (!response.ok) throw new PriceSourceError(`${url.host} answered HTTP ${response.status}.`);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new PriceSourceError(`${url.host} answered with a body that is not JSON.`);
    }
  }
}
