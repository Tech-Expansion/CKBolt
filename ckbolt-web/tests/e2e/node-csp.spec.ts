import { createHash } from "node:crypto";
import { test as base, expect, type APIResponse, type BrowserContext, type Frame, type Page } from "@playwright/test";
import { nodePageCsp } from "../../lib/csp";
import { MOTION_RESTORE_SCRIPT } from "../../lib/motion";
import { CKB_RPC_DEFAULT_URL } from "../../lib/wallets/fiber-browser/constants";
import { FIBER_WALLET_PATH } from "../../lib/wallets/fiber-popup/constants";
import { installFakeNode, openRunningNode } from "./support/fiber-node";
import { browserHasDip, createWalletNode, DIP_PROBE_TIMEOUT_MS, exposeRealLockArgs, NO_DIP_REASON, openWalletPopup, walletFrame } from "./support/fiber-wallet";
import { isolate, LiveHub } from "./support/live-hub";

/*
 * The node pages' Content-Security-Policy (security review W4, docs/fiber-wallet-popup.md "The pages'
 * Content-Security-Policy") against the built server: /app/fiber and /app/wallet get proxy.ts's strict policy with a
 * fresh nonce per request, which Next.js puts on every script of the page; every other page keeps next.config.mjs's
 * framing policy and the hub proxy its sandbox. Then in the browser (real Chrome: PW_CHANNEL=chrome): the node page and
 * the popup's iframe create and run a node (the fake fiber-js of support/fiber-node.ts) with no CSP violation, and the
 * policy still refuses what it should. lib/csp.ts itself is tests/unit/node-csp.spec.ts.
 */

/** The rest of the site's policy (next.config.mjs). */
const FRAMING_POLICY = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";
/** The hub proxy's own (lib/hub/constants.ts). */
const HUB_PROXY_POLICY = "default-src 'none'; sandbox";
const NONCE = /'nonce-([^']+)'/;
const MOTION_HASH = `'sha256-${createHash("sha256").update(MOTION_RESTORE_SCRIPT, "utf8").digest("base64")}'`;

/** The node pages, the query that makes /app/fiber the popup's window, and who may frame each. */
const NODE_PAGES = [
  { path: "/app/fiber", frameAncestors: "'none'" },
  { path: "/app/fiber?view=wallet", frameAncestors: "'none'" },
  { path: FIBER_WALLET_PATH, frameAncestors: "'self'" },
] as const;

/** Every Content-Security-Policy header of a response (a page must send exactly one). */
const policiesOf = (res: APIResponse) =>
  res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "content-security-policy")
    .map((h) => h.value);

interface ScriptTag {
  attrs: string;
  text: string;
  nonce: string | null;
  src: string | null;
}

/** The page's <script> tags as the server sent them (a browser hides the nonce attribute from the DOM). */
function scriptTags(html: string): ScriptTag[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map(([, attrs, text]) => ({
    attrs,
    text,
    nonce: attrs.match(/\bnonce="([^"]*)"/)?.[1] ?? null,
    src: attrs.match(/\bsrc="([^"]*)"/)?.[1] ?? null,
  }));
}

/* ------------------------------------------------------------------------------------------- the server */

base.describe("the node pages' policy, as the server sends it", () => {
  base("/app/fiber and /app/wallet: the strict policy, one per response, with a nonce that every script of the page carries", async ({ request }) => {
    for (const { path, frameAncestors } of NODE_PAGES) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      const policies = policiesOf(res);
      expect(policies, path).toHaveLength(1);
      const nonce = policies[0].match(NONCE)?.[1];
      expect(nonce, path).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      // The exact policy for this nonce: the server under test is plain http, a production build (no 'unsafe-eval').
      expect(policies[0], path).toBe(nodePageCsp({ nonce: nonce!, frameAncestors, ckbRpcUrl: CKB_RPC_DEFAULT_URL.testnet, plainHttp: true, dev: false }));
      expect(policies[0].split("; ").find((d) => d.startsWith("script-src")), path).not.toMatch(/'unsafe-(inline|eval)'/);

      const scripts = scriptTags(await res.text());
      const withNonce = scripts.filter((s) => s.nonce !== null);
      // Next.js's own scripts (its chunks and the inline RSC payload) carry this response's nonce...
      expect(withNonce.length, path).toBeGreaterThan(1);
      for (const s of withNonce) expect(s.nonce, `${path}: ${s.attrs}`).toBe(nonce);
      expect(scripts.filter((s) => s.src !== null && s.nonce === null).map((s) => s.src), path).toEqual([]);
      // ...and the one script without it is the root layout's motion restore, which the policy allows by its hash.
      const inline = scripts.filter((s) => s.nonce === null);
      expect(inline.map((s) => s.text), path).toEqual([MOTION_RESTORE_SCRIPT]);
      expect(policies[0], path).toContain(MOTION_HASH);
    }
  });

  base("a new nonce on every request, on the page as in the header: the pages render per request", async ({ request }) => {
    for (const { path } of NODE_PAGES) {
      const seen: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await request.get(path);
        const nonce = policiesOf(res)[0].match(NONCE)![1];
        const html = await res.text();
        expect(scriptTags(html).filter((s) => s.nonce !== null).every((s) => s.nonce === nonce), path).toBe(true);
        for (const earlier of seen) expect(html, path).not.toContain(earlier);
        seen.push(nonce);
      }
      expect(new Set(seen).size, path).toBe(3);
    }
  });

  base("every other page keeps the framing policy only (no nonce, so it stays static), and the hub proxy its sandbox", async ({ request }) => {
    for (const path of ["/", "/app", "/app?mode=swap", "/app/guide", "/app/fiber/fund", "/app/fiber/fund?address=ckt1q", "/brand", "/brand-assets"]) {
      const res = await request.get(path);
      expect(policiesOf(res), path).toEqual([FRAMING_POLICY]);
      expect(scriptTags(await res.text()).filter((s) => s.nonce !== null), path).toEqual([]);
    }
    for (const path of ["/api/hub/v1/health", "/api/hub/v1/fiber/node"]) {
      expect(policiesOf(await request.get(path)), path).toEqual([HUB_PROXY_POLICY]);
    }
  });
});

/* ------------------------------------------------------------------------------------------ the browser */

interface Fixtures {
  hub: LiveHub;
  /** The browser isolates the popover's iframe with Document-Isolation-Policy. */
  dip: boolean;
}

const test = base.extend<Fixtures>({
  hub: async ({ context }, use) => {
    await isolate(context);
    const hub = new LiveHub();
    await hub.install(context);
    await use(hub);
  },
  dip: [
    async ({ browser, baseURL }, use) => {
      await use(await browserHasDip(browser, baseURL!));
    },
    { timeout: DIP_PROBE_TIMEOUT_MS },
  ],
});

interface Violation {
  directive: string;
  blocked: string;
  sample: string;
  url: string;
}

/**
 * Records every securitypolicyviolation in every document of the context (pages and iframes), and every console line
 * that names the policy, from before the site's scripts run.
 */
async function watchViolations(context: BrowserContext): Promise<{ console: string[] }> {
  await context.addInitScript(() => {
    const w = window as unknown as { __cspViolations: Violation[] };
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__cspViolations.push({ directive: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample, url: e.documentURI });
    });
  });
  const console: string[] = [];
  context.on("console", (message) => {
    if (/content security policy/i.test(message.text())) console.push(message.text());
  });
  return { console };
}

const violationsIn = (scope: Page | Frame): Promise<Violation[]> => scope.evaluate(() => (window as unknown as { __cspViolations: Violation[] }).__cspViolations);

/**
 * What fiber-js needs from the policy, tried in a document: a worker from a blob: URL of its own code, which compiles
 * WebAssembly ('wasm-unsafe-eval') but cannot eval (no 'unsafe-eval'). The worker inherits the page's policy.
 */
function tryFiberJsNeeds(scope: Page | Frame) {
  return scope.evaluate(
    () =>
      new Promise<{ worker: string; wasm?: string; eval?: string }>((resolve) => {
        const code = `
          const out = {};
          try { eval("1"); out.eval = "ran"; } catch (e) { out.eval = "blocked"; }
          // The smallest valid module: the magic number and version 1.
          WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(
            () => postMessage({ ...out, wasm: "compiled" }),
            (e) => postMessage({ ...out, wasm: "refused: " + e }),
          );`;
        let worker: Worker;
        try {
          worker = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
        } catch (e) {
          resolve({ worker: `refused: ${e}` });
          return;
        }
        const timer = setTimeout(() => resolve({ worker: "no answer" }), 10_000);
        worker.onmessage = (event) => {
          clearTimeout(timer);
          worker.terminate();
          resolve({ worker: "started", ...(event.data as { wasm: string; eval: string }) });
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          resolve({ worker: `error: ${event.message}` });
        };
      }),
  );
}

/** An inline event handler, which no nonce or hash allows: the policy must refuse it, with a violation. */
function tryInlineHandler(scope: Page | Frame) {
  return scope.evaluate(() => {
    const w = window as unknown as { __inlineRan?: boolean };
    const button = document.createElement("button");
    button.setAttribute("onclick", "window.__inlineRan = true");
    document.body.append(button);
    button.click();
    button.remove();
    return w.__inlineRan === true;
  });
}

test.describe("the node pages' policy in the browser", () => {
  test("the node page creates and runs a node under its policy: no violation, the motion script runs by its hash, inline handlers are refused", async ({
    context,
    hub: _hub,
  }) => {
    test.setTimeout(90_000);
    const seen = await watchViolations(context);
    // The visitor paused motion earlier: the layout's inline script (allowed by its hash) must restore it before paint.
    await context.addInitScript(() => {
      try {
        localStorage.setItem("ckbolt-motion", "paused");
      } catch {
        // No storage, no choice to restore.
      }
    });
    await installFakeNode(context);
    await exposeRealLockArgs(context);
    const page = await openRunningNode(context);
    expect(await page.evaluate(() => document.documentElement.dataset.motion)).toBe("paused");
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    expect(await violationsIn(page)).toEqual([]);
    expect(seen.console).toEqual([]);

    // What fiber-js does in its workers is allowed; eval is not (the worker's refusal is reported in the worker, so the
    // page's list stays empty: no worker-src refusal).
    expect(await tryFiberJsNeeds(page)).toEqual({ worker: "started", eval: "blocked", wasm: "compiled" });
    expect(await violationsIn(page)).toEqual([]);

    // The listener hears what the policy refuses: an inline handler does not run.
    expect(await tryInlineHandler(page)).toBe(false);
    expect((await violationsIn(page)).map((v) => v.directive)).toEqual(["script-src-attr"]);
  });

  test("the popup's iframe (/app/wallet) creates and runs a node under its policy: no violation in the page or the iframe", async ({
    page,
    context,
    hub: _hub,
    dip,
  }) => {
    test.skip(!dip, NO_DIP_REASON);
    test.setTimeout(120_000);
    const seen = await watchViolations(context);
    await installFakeNode(context);
    await exposeRealLockArgs(context);
    const wallet = await openWalletPopup(page, "/app");
    await createWalletNode(wallet.ui);
    const frame = (await walletFrame(page)) as Frame;
    expect(await frame.evaluate(() => crossOriginIsolated)).toBe(true);
    expect(await violationsIn(page)).toEqual([]);
    expect(await violationsIn(frame)).toEqual([]);
    expect(seen.console).toEqual([]);
    // fiber-js's needs hold in the iframe too, and its policy refuses an inline handler.
    expect(await tryFiberJsNeeds(frame)).toEqual({ worker: "started", eval: "blocked", wasm: "compiled" });
    expect(await violationsIn(frame)).toEqual([]);
    expect(await tryInlineHandler(frame)).toBe(false);
    expect((await violationsIn(frame)).map((v) => v.directive)).toEqual(["script-src-attr"]);
    // The page around it has the framing policy only: nothing it does was reported.
    expect(await violationsIn(page)).toEqual([]);
  });
});
