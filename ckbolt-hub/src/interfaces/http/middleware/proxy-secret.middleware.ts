import { UnauthorizedError } from "../errors/http.errors";
import { carriesProxySecret, type ClientRequest } from "../rate-limit/client-key";

/** An Express middleware: `next()` passes the request on, `next(error)` answers it with the error. */
export type ExpressMiddleware = (request: ClientRequest, response: unknown, next: (error?: unknown) => void) => void;

/**
 * With HUB_PROXY_SECRET set, only the web app's proxy (and the deploy kit) may call the hub: a request without the secret
 * in X-CKBolt-Proxy-Secret answers 401 unauthorized. It is the app's first middleware (configureHttpApp), so a refused
 * request learns nothing of the API, spends no client's budget and never has its body read or parsed. Without the
 * setting (null) every request passes.
 */
export function proxySecretMiddleware(secret: string | null): ExpressMiddleware {
  return (request, _response, next) => {
    if (secret !== null && !carriesProxySecret(request, secret)) {
      next(new UnauthorizedError());
      return;
    }
    next();
  };
}
