import type { NestApplicationOptions } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { JSON_BODY_LIMIT } from "../../common/constants/http.constants";
import type { HubConfig } from "../../config/hub.config";
import { proxySecretMiddleware } from "./middleware/proxy-secret.middleware";

/**
 * Options every hub app is created with. Nest's own body parsers stay off: they would read and parse every body before
 * any middleware of a module could refuse the request, so configureHttpApp registers the JSON parser itself, after the
 * proxy secret check.
 */
export const HTTP_APP_OPTIONS = { bodyParser: false } as const satisfies NestApplicationOptions;

/**
 * The Express middleware every hub app runs before routing, in this order: the proxy secret (HUB_PROXY_SECRET), so a
 * request without it is refused with 401 before its body is read; the JSON body parser, up to JSON_BODY_LIMIT; CORS
 * when HUB_CORS_ORIGINS lists origins. Called on an app created with HTTP_APP_OPTIONS, before init or listen (main.ts,
 * and the tests that boot the app).
 */
export function configureHttpApp(app: NestExpressApplication, config: HubConfig): void {
  app.use(proxySecretMiddleware(config.server.proxySecret));
  app.useBodyParser("json", { limit: JSON_BODY_LIMIT });
  if (config.server.corsOrigins.length > 0) app.enableCors({ origin: config.server.corsOrigins });
}
