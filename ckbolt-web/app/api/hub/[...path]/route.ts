import { readHubProxyConfig } from "@/lib/hub/config";
import { createHubProxy, type HubProxy } from "@/lib/hub/proxy";

// Same-origin proxy to the CKBolt hub (HUB_URL). Without HUB_URL every call answers 503 hub_unavailable and the
// app says the hub is not available. Live swap state must never be cached.
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ path: string[] }> };

// Composition root: one proxy per server process, so its rate limiter sees every request. Built on first use, so the
// environment is read at run time, not at build time.
let proxy: HubProxy | null = null;
const getProxy = (): HubProxy => (proxy ??= createHubProxy(readHubProxyConfig(process.env)));

async function forward(request: Request, { params }: Context): Promise<Response> {
  return getProxy().handle(request, (await params).path);
}

// Every method reaches the proxy, so a wrong one gets the API's own 405 body instead of an empty one.
export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
