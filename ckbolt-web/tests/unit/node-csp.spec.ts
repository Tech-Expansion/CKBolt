import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { NextRequest } from "next/server";
import { config as proxyConfig, proxy } from "../../proxy";
import { inlineScriptSource, newCspNonce, nodePageCsp, type NodePageCspOptions } from "../../lib/csp";
import { MOTION_RESTORE_SCRIPT } from "../../lib/motion";
import { parseBrowserNodeConfig } from "../../lib/wallets/fiber-browser/config";
import { CKB_RPC_DEFAULT_URL, FIBER_NODE_PAGE_PATH } from "../../lib/wallets/fiber-browser/constants";
import { FIBER_WALLET_PATH } from "../../lib/wallets/fiber-popup/constants";

/*
 * The node pages' Content-Security-Policy (security review W4, docs/fiber-wallet-popup.md "The pages'
 * Content-Security-Policy"): lib/csp.ts builds it, proxy.ts sends it on /app/fiber and /app/wallet with a fresh nonce
 * per request. No browser, no server: the built server and a real Chrome load are tests/e2e/node-csp.spec.ts.
 */

const WEB = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(WEB, p), "utf8");

/** The motion script's hash, computed here with node:crypto, not with lib/csp.ts's own code. */
const MOTION_HASH = `'sha256-${createHash("sha256").update(MOTION_RESTORE_SCRIPT, "utf8").digest("base64")}'`;

const BASE: NodePageCspOptions = {
  nonce: "bm9uY2Utbm9uY2Utbm9uY2U=",
  frameAncestors: "'self'",
  ckbRpcUrl: CKB_RPC_DEFAULT_URL.testnet,
  plainHttp: false,
  dev: false,
};

/** A policy as directive name to its sources; fails on a directive named twice (a browser would ignore the second). */
function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(";").map((p) => p.trim()).filter(Boolean)) {
    const [name, ...sources] = part.split(/\s+/);
    expect(out.has(name), `${name} named twice`).toBe(false);
    out.set(name, sources);
  }
  return out;
}

const NONCE_OF = /'nonce-([^']+)'/;

test.describe("lib/csp.ts: the node pages' policy", () => {
  test("the exact policy: nonce, strict-dynamic, the motion script's hash, WASM, blob workers, the CKB RPC and wss:", () => {
    expect(nodePageCsp(BASE)).toBe(
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${BASE.nonce}' 'strict-dynamic' ${MOTION_HASH} 'wasm-unsafe-eval'`,
        "worker-src 'self' blob:",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self'",
        "connect-src 'self' https://testnet.ckbapp.dev wss:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'",
      ].join("; "),
    );
  });

  test("scripts run only by nonce or hash: no 'unsafe-inline', no 'unsafe-eval' and no host outside dev", () => {
    for (const plainHttp of [false, true]) {
      for (const frameAncestors of ["'self'", "'none'"] as const) {
        const script = directives(nodePageCsp({ ...BASE, plainHttp, frameAncestors })).get("script-src")!;
        expect(script).not.toContain("'unsafe-inline'");
        expect(script).not.toContain("'unsafe-eval'");
        expect(script).toContain("'strict-dynamic'");
        // Every source is a keyword, the nonce or a hash: no scheme or host that 'strict-dynamic' browsers ignore anyway.
        expect(script.filter((s) => !/^'[^']+'$/.test(s))).toEqual([]);
      }
    }
  });

  test("'unsafe-eval' only under next dev, and nothing else changes with it", () => {
    const build = directives(nodePageCsp(BASE));
    const dev = directives(nodePageCsp({ ...BASE, dev: true }));
    expect(dev.get("script-src")).toEqual([...build.get("script-src")!, "'unsafe-eval'"]);
    for (const [name, sources] of build) if (name !== "script-src") expect(dev.get(name), name).toEqual(sources);
    expect([...dev.keys()]).toEqual([...build.keys()]);
  });

  test("ws: only on a plain-http page (a local next start), in connect-src alone", () => {
    const https = nodePageCsp(BASE);
    const http = nodePageCsp({ ...BASE, plainHttp: true });
    expect(directives(https).get("connect-src")).toEqual(["'self'", "https://testnet.ckbapp.dev", "wss:"]);
    expect(directives(http).get("connect-src")).toEqual(["'self'", "https://testnet.ckbapp.dev", "wss:", "ws:"]);
    expect(https.split(/[\s;]+/)).not.toContain("ws:");
    expect(http.split(/[\s;]+/).filter((s) => s === "ws:")).toHaveLength(1);
  });

  test("frame-ancestors per page: 'self' for the popup's iframe, 'none' for the node page; the rest is the same", () => {
    const wallet = directives(nodePageCsp({ ...BASE, frameAncestors: "'self'" }));
    const node = directives(nodePageCsp({ ...BASE, frameAncestors: "'none'" }));
    expect(wallet.get("frame-ancestors")).toEqual(["'self'"]);
    expect(node.get("frame-ancestors")).toEqual(["'none'"]);
    for (const [name, sources] of wallet) if (name !== "frame-ancestors") expect(node.get(name), name).toEqual(sources);
  });

  test("connect-src names the CKB RPC's origin only (scheme, host, port), from the build's config", () => {
    const of = (ckbRpcUrl: string) => directives(nodePageCsp({ ...BASE, ckbRpcUrl })).get("connect-src")![1];
    expect(of("https://testnet.ckbapp.dev/")).toBe("https://testnet.ckbapp.dev");
    expect(of("http://127.0.0.1:8114/rpc?key=secret")).toBe("http://127.0.0.1:8114");
    expect(of("https://rpc.example.org:8443/a/b/")).toBe("https://rpc.example.org:8443");
    // The default and a deployment's own RPC, as readBrowserNodeConfig hands them over.
    expect(of(parseBrowserNodeConfig({}).ckbRpcUrl)).toBe("https://testnet.ckbapp.dev");
    expect(of(parseBrowserNodeConfig({ ckbRpcUrl: "https://ckb.example.net/rpc" }).ckbRpcUrl)).toBe("https://ckb.example.net");
  });

  test("a fresh nonce per call: 16 random bytes in base64, never the same twice, valid in a CSP source", () => {
    const nonces = Array.from({ length: 200 }, () => newCspNonce());
    expect(new Set(nonces).size).toBe(nonces.length);
    for (const nonce of nonces) {
      // CSP's base64-value grammar; 16 bytes are 22 characters and two pads.
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(Buffer.from(nonce, "base64")).toHaveLength(16);
    }
    // The policy carries the nonce it is given, once.
    const policy = nodePageCsp({ ...BASE, nonce: nonces[0] });
    expect(policy.match(new RegExp(NONCE_OF, "g"))).toHaveLength(1);
    expect(policy.match(NONCE_OF)![1]).toBe(nonces[0]);
  });

  test("the hash allows exactly the root layout's inline script, which is the motion restore as it was", () => {
    expect(inlineScriptSource(MOTION_RESTORE_SCRIPT)).toBe(MOTION_HASH);
    // The script's text did not change when it became a constant (the layout inlined this literal before).
    expect(MOTION_RESTORE_SCRIPT).toBe("try{if(localStorage.getItem('ckbolt-motion')==='paused')document.documentElement.dataset.motion='paused'}catch(e){}");
    // One character more is another hash: the policy allows that text only.
    expect(inlineScriptSource(`${MOTION_RESTORE_SCRIPT};`)).not.toBe(MOTION_HASH);
    expect(inlineScriptSource(` ${MOTION_RESTORE_SCRIPT}`)).not.toBe(MOTION_HASH);
    // The layout renders the constant as it is, and it is the app's one inline script.
    const layout = read("app/layout.tsx");
    expect(layout).toContain("__html: MOTION_RESTORE_SCRIPT,");
    expect(layout.match(/dangerouslySetInnerHTML/g)).toHaveLength(1);
    expect(layout).not.toContain("next/script");
  });
});

test.describe("proxy.ts: the policy on the node pages, a nonce per request", () => {
  /** What the proxy answers for a request to `url`: the response's policy and the one it hands Next.js. */
  function proxied(url: string) {
    const response = proxy(new NextRequest(url));
    const policy = response.headers.get("content-security-policy");
    // NextResponse.next({ request: { headers } }) passes the request's headers to the page through these.
    const overridden = (response.headers.get("x-middleware-override-headers") ?? "").split(",");
    const forPage = response.headers.get("x-middleware-request-content-security-policy");
    return { policy, overridden, forPage };
  }

  test("matches the node page and the popup's iframe only, by the same paths the app uses", () => {
    expect(proxyConfig.matcher).toEqual([FIBER_NODE_PAGE_PATH, FIBER_WALLET_PATH]);
    expect([FIBER_NODE_PAGE_PATH, FIBER_WALLET_PATH]).toEqual(["/app/fiber", "/app/wallet"]);
    // Next.js reads the matcher at build time: it must stay literal in the file.
    expect(read("proxy.ts")).toContain('matcher: ["/app/fiber", "/app/wallet"]');
  });

  test("/app/wallet: frame-ancestors 'self'; /app/fiber: 'none'; the same policy goes to the page, so Next.js puts its nonce on the scripts", () => {
    for (const [url, frameAncestors] of [
      ["https://ckbolt.example/app/wallet", "'self'"],
      ["https://ckbolt.example/app/fiber", "'none'"],
      ["https://ckbolt.example/app/fiber?view=wallet", "'none'"],
    ] as const) {
      const { policy, overridden, forPage } = proxied(url);
      expect(policy, url).not.toBeNull();
      const nonce = policy!.match(NONCE_OF)![1];
      expect(policy, url).toBe(nodePageCsp({ nonce, frameAncestors, ckbRpcUrl: CKB_RPC_DEFAULT_URL.testnet, plainHttp: false, dev: false }));
      expect(forPage, url).toBe(policy);
      expect(overridden, url).toContain("content-security-policy");
    }
  });

  test("a new nonce on every request", () => {
    const nonces = Array.from({ length: 20 }, () => proxied("https://ckbolt.example/app/fiber").policy!.match(NONCE_OF)![1]);
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  test("ws: on a plain-http server only; no 'unsafe-eval' outside next dev", () => {
    const http = directives(proxied("http://localhost:3100/app/wallet").policy!);
    const https = directives(proxied("https://ckbolt.example/app/wallet").policy!);
    expect(http.get("connect-src")).toContain("ws:");
    expect(https.get("connect-src")).not.toContain("ws:");
    expect(process.env.NODE_ENV).not.toBe("development");
    expect(http.get("script-src")).not.toContain("'unsafe-eval'");
    expect(https.get("script-src")).not.toContain("'unsafe-eval'");
  });

  test("keeps the request's other headers for the page", () => {
    const response = proxy(new NextRequest("https://ckbolt.example/app/fiber", { headers: { "accept-language": "en-US", cookie: "a=b" } }));
    expect(response.headers.get("x-middleware-request-accept-language")).toBe("en-US");
    expect(response.headers.get("x-middleware-request-cookie")).toBe("a=b");
  });
});
