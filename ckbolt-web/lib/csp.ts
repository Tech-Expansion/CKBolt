import { sha256 } from "@noble/hashes/sha2.js";
import { MOTION_RESTORE_SCRIPT } from "@/lib/motion";

/**
 * The Content-Security-Policy of the two pages that run the visitor's Fiber node (security review W4): the node page
 * (/app/fiber, also the popup in a window with ?view=wallet) and the header popup's iframe (/app/wallet). proxy.ts sends
 * it with a fresh nonce per request; next.config.mjs sends the rest of the site its own policy (framing only) and leaves
 * these two pages to proxy.ts. Every source below that is not this site's own says why it is there.
 */

/** Who may frame the page: the popup's iframe by this site's own pages, the node page by nobody. */
export type FrameAncestors = "'self'" | "'none'";

export interface NodePageCspOptions {
  /** A fresh random nonce for this response (newCspNonce). Next.js reads it from the request's CSP and puts it on its scripts. */
  nonce: string;
  frameAncestors: FrameAncestors;
  /** The CKB RPC the node, its balance reader and CCC's client on the node page use (BrowserNodeConfig.ckbRpcUrl). */
  ckbRpcUrl: string;
  /**
   * The page is served over plain http (a local `next start`): the node may then dial ws:// peers as well as wss://
   * (needsTlsPeers in lib/wallets/fiber-browser/node-config.ts). Never on the public https site.
   */
  plainHttp: boolean;
  /** `next dev`: React uses eval for its error overlay and stack traces there. Never in a build. */
  dev: boolean;
}

const NONCE_BYTES = 16;

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

/** A fresh nonce: 16 random bytes in base64. */
export const newCspNonce = (): string => base64(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));

/** The CSP source that allows one inline script by its exact text. */
export const inlineScriptSource = (text: string): string => `'sha256-${base64(sha256(new TextEncoder().encode(text)))}'`;

/** The scheme, host and port of a URL, as a CSP source. */
const originOf = (url: string): string => new URL(url).origin;

/** The policy for one response of a node page. */
export function nodePageCsp(options: NodePageCspOptions): string {
  const directives: [string, string[]][] = [
    // Whatever is not named below: this site only.
    ["default-src", ["'self'"]],
    [
      "script-src",
      [
        // Next.js puts the nonce on every script it renders; the chunks those scripts load are trusted through them
        // ('strict-dynamic'), so no host list and no 'unsafe-inline'. 'self' is for browsers without 'strict-dynamic'
        // only: those that have it ignore 'self'.
        "'self'",
        `'nonce-${options.nonce}'`,
        "'strict-dynamic'",
        // The root layout's one inline script of its own (lib/motion.ts), by its hash.
        inlineScriptSource(MOTION_RESTORE_SCRIPT),
        // fiber-js compiles its WASM node (inlined in its bundle) in its workers. This allows WebAssembly only, not eval.
        "'wasm-unsafe-eval'",
        ...(options.dev ? ["'unsafe-eval'"] : []),
      ],
    ],
    // fiber-js starts its two workers from blob: URLs it makes of its own bundled code (new Worker(blob URL)).
    ["worker-src", ["'self'", "blob:"]],
    // React style attributes and the inline styles of CCC's wallet connector (the withdraw address picker). Styles run no code.
    ["style-src", ["'self'", "'unsafe-inline'"]],
    // Token icons: the hub's iconUrl (https on any host, checked by lib/token-display.ts), inline SVG icons and QR codes as
    // data:, and the wallet icons CCC's connector shows.
    ["img-src", ["'self'", "data:", "blob:", "https:"]],
    ["font-src", ["'self'"]],
    [
      "connect-src",
      [
        // The same-origin API routes (the hub proxy, /api/rate) and Next.js's own requests.
        "'self'",
        // The node's CKB RPC (fiber-js, the balance reader, CCC's client for Withdraw), from this build's config.
        originOf(options.ckbRpcUrl),
        // Fiber peers over WebSocket, on any host: the hub's addresses come from the hub at run time (GET /v1/fiber/node),
        // the bootnodes from NEXT_PUBLIC_CKBOLT_FIBER_BOOTNODES, and "a channel with another node" dials the address the
        // visitor types. A WebSocket carries only what fiber-js sends to its peers.
        "wss:",
        ...(options.plainHttp ? ["ws:"] : []),
      ],
    ],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", [options.frameAncestors]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(" ")}`).join("; ");
}
