import { NextResponse, type NextRequest } from "next/server";
import { newCspNonce, nodePageCsp } from "@/lib/csp";
import { readBrowserNodeConfig } from "@/lib/wallets/fiber-browser/config";
import { FIBER_WALLET_PATH } from "@/lib/wallets/fiber-popup/constants";

/**
 * Next.js Proxy (the former middleware): the Content-Security-Policy of the two pages that run the visitor's Fiber node
 * (security review W4, lib/csp.ts), with a fresh nonce per request. Next.js reads the nonce from the request's policy
 * and puts it on the scripts it renders, so both pages render per request (/app/wallet calls connection()). The other
 * pages keep the policy next.config.mjs sends, which leaves these two to this file.
 */
export function proxy(request: NextRequest) {
  const policy = nodePageCsp({
    nonce: newCspNonce(),
    // The popup's iframe is framed by this site's own pages; the node page by nobody (as next.config.mjs had it).
    frameAncestors: request.nextUrl.pathname === FIBER_WALLET_PATH ? "'self'" : "'none'",
    ckbRpcUrl: readBrowserNodeConfig().ckbRpcUrl,
    plainHttp: request.nextUrl.protocol === "http:",
    dev: process.env.NODE_ENV === "development",
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

/**
 * The node page (FIBER_NODE_PAGE_PATH in lib/wallets/fiber-browser/constants.ts) and the popup's iframe
 * (FIBER_WALLET_PATH). Literals: Next.js reads the matcher at build time and ignores anything it cannot read statically.
 */
export const config = {
  matcher: ["/app/fiber", "/app/wallet"],
};
