import { BROWSER_NODE_NETWORK, CKB_RPC_DEFAULT_URL, type BrowserNodeNetwork } from "./constants";

/** Settings of the browser Fiber node that a deployment may change. */
export interface BrowserNodeConfig {
  network: BrowserNodeNetwork;
  /** CKB JSON-RPC with indexer methods and CORS, used by the node and by the balance reader. */
  ckbRpcUrl: string;
  /** Extra WSS multiaddrs the node dials at start, besides the hub's (`/dns4/<host>/tcp/443/wss/p2p/<id>`). */
  bootnodes: string[];
}

/**
 * Public environment variables (inlined at build time by Next.js, so each is read by its literal name below):
 * - NEXT_PUBLIC_CKBOLT_FIBER_CKB_RPC_URL: the CKB RPC URL (default: the public testnet RPC in ./constants.ts);
 * - NEXT_PUBLIC_CKBOLT_FIBER_BOOTNODES: comma-separated multiaddrs to dial besides the hub (default: none).
 */
export interface BrowserNodeEnv {
  ckbRpcUrl?: string;
  bootnodes?: string;
}

const httpUrl = (raw: string | undefined): string | null => {
  const text = raw?.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
};

const list = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("/"));

/** The node's settings from the given environment values, with the defaults for anything unset or malformed. */
export function parseBrowserNodeConfig(env: BrowserNodeEnv): BrowserNodeConfig {
  return {
    network: BROWSER_NODE_NETWORK,
    ckbRpcUrl: httpUrl(env.ckbRpcUrl) ?? CKB_RPC_DEFAULT_URL[BROWSER_NODE_NETWORK],
    bootnodes: list(env.bootnodes),
  };
}

/** The node's settings for this build. */
export function readBrowserNodeConfig(): BrowserNodeConfig {
  return parseBrowserNodeConfig({
    ckbRpcUrl: process.env.NEXT_PUBLIC_CKBOLT_FIBER_CKB_RPC_URL,
    bootnodes: process.env.NEXT_PUBLIC_CKBOLT_FIBER_BOOTNODES,
  });
}
