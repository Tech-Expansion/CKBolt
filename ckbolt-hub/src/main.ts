import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { HUB_CONFIG } from "./application/ports/tokens";
import { loadEnvFile } from "./config/env-file";
import type { HubConfig } from "./config/hub.config";
import { configureHttpApp, HTTP_APP_OPTIONS } from "./interfaces/http/http-app";

async function bootstrap(): Promise<void> {
  loadEnvFile();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { ...HTTP_APP_OPTIONS, bufferLogs: false });
  const config = app.get<HubConfig>(HUB_CONFIG);
  configureHttpApp(app, config);
  app.enableShutdownHooks();
  await app.listen(config.server.port, config.server.host);
  new Logger("Bootstrap").log(`CKBolt hub listening on http://${config.server.host}:${config.server.port}`);
}

void bootstrap();
