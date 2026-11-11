import { HUB_CONFIG_PROBLEM, HUB_ENV, HUB_PROXY_DEFAULTS, LOOPBACK_HOSTNAMES, TRUST_PROXY_ENABLED } from "./constants";
import type { RateLimitPolicy } from "./rate-limit";

/** Settings of the server-side hub proxy, read once from the environment. */
export interface HubProxyConfig {
  /** Base URL of the hub without a trailing slash, or null when live swaps are off. */
  hubUrl: string | null;
  timeoutMs: number;
  maxBodyBytes: number;
  /** True behind our own reverse proxy: the last X-Forwarded-For entry identifies the client. */
  trustProxy: boolean;
  rateLimit: RateLimitPolicy;
  /** The secret the hub requires (HUB_PROXY_SECRET), or null when unset. Server only: never sent to the browser. */
  proxySecret: string | null;
  /**
   * Unsafe combinations of the settings above (HUB_CONFIG_PROBLEM lines, each naming its fix); empty when there are
   * none. With any, the proxy forwards nothing: it answers 503 hub_unavailable and logs them.
   */
  problems: readonly string[];
}

export type Env = Readonly<Record<string, string | undefined>>;

/** An http(s) URL without a trailing slash, or null for anything else (unset, empty or malformed). */
export function parseHubUrl(raw: string | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Whether a hub URL points at this machine, such as the local end of an SSH tunnel. */
export const isLoopbackUrl = (hubUrl: string): boolean => LOOPBACK_HOSTNAMES.includes(new URL(hubUrl).hostname);

/**
 * What is unsafe about sending the hub HUB_PROXY_SECRET: over plain http the secret can be read on the way, and
 * without TRUST_PROXY every visitor reaches the hub under one client key. Both are fine for a hub on this machine.
 */
export function secretProblems(hubUrl: string | null, proxySecret: string | null, trustProxy: boolean): string[] {
  if (!hubUrl || !proxySecret || isLoopbackUrl(hubUrl)) return [];
  const problems: string[] = [];
  if (new URL(hubUrl).protocol !== "https:") problems.push(HUB_CONFIG_PROBLEM.SECRET_OVER_HTTP);
  if (!trustProxy) problems.push(HUB_CONFIG_PROBLEM.SECRET_WITHOUT_TRUST_PROXY);
  return problems;
}

/** A positive whole number from the environment, or the fallback when it is unset or not one. */
export function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim());
  return raw !== undefined && Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function readHubProxyConfig(env: Env): HubProxyConfig {
  const trustProxy = env[HUB_ENV.TRUST_PROXY] === TRUST_PROXY_ENABLED;
  // Without a trusted proxy every caller shares one key, so that budget is larger.
  const maxPerClient = trustProxy
    ? positiveInt(env[HUB_ENV.RATE_LIMIT_PER_MINUTE], HUB_PROXY_DEFAULTS.perClientPerWindow)
    : positiveInt(env[HUB_ENV.SHARED_RATE_LIMIT_PER_MINUTE], HUB_PROXY_DEFAULTS.sharedPerWindow);
  const hubUrl = parseHubUrl(env[HUB_ENV.HUB_URL]);
  const proxySecret = env[HUB_ENV.PROXY_SECRET]?.trim() || null;
  return {
    hubUrl,
    timeoutMs: positiveInt(env[HUB_ENV.TIMEOUT_MS], HUB_PROXY_DEFAULTS.timeoutMs),
    maxBodyBytes: positiveInt(env[HUB_ENV.MAX_BODY_BYTES], HUB_PROXY_DEFAULTS.maxBodyBytes),
    trustProxy,
    rateLimit: {
      windowMs: HUB_PROXY_DEFAULTS.rateWindowMs,
      maxPerClient,
      maxGlobal: positiveInt(env[HUB_ENV.GLOBAL_RATE_LIMIT_PER_MINUTE], HUB_PROXY_DEFAULTS.globalPerWindow),
      maxTrackedClients: HUB_PROXY_DEFAULTS.maxTrackedClients,
    },
    proxySecret,
    problems: secretProblems(hubUrl, proxySecret, trustProxy),
  };
}
