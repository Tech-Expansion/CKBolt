import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Alert, AlertLevel, AlertSink } from "../../../src/application/ports/alert-sink.port";
import { ALERT_SINK, HUB_CONFIG } from "../../../src/application/ports/tokens";
import { ALERT_LEVEL_MARK, ALERT_WEBHOOK_FORMAT, type AlertWebhookFormat } from "../../../src/common/constants/monitoring.constants";
import { HubConfigModule } from "../../../src/config/config.module";
import { AlertsModule } from "../../../src/infrastructure/alerts/alerts.module";
import { alertText, LogAlertSink, webhookBody, WebhookAlertSink, type WebhookAlertSettings } from "../../../src/infrastructure/alerts/webhook-alert-sink";
import { monitorConfig } from "./monitoring.fixtures";

/**
 * Where alerts go (src/infrastructure/alerts): a webhook POST in the format ALERT_WEBHOOK_FORMAT names, within
 * ALERT_WEBHOOK_TIMEOUT_MS, or the log without ALERT_WEBHOOK_URL. fetch is a mock here: nothing touches the network.
 */

const WEBHOOK_URL = "https://alerts.example.com/hook";
const TELEGRAM_CHAT_ID = "-1001234567890";
const TIMEOUT_MS = 2_500;
const HTTP_OK = 200;
const HTTP_SERVER_ERROR = 500;

const ALERT: Alert = { key: "health", level: "critical", title: "Hub degraded", detail: "The hub's Lightning node does not answer." };
const ALERT_LINE = "[CRITICAL] Hub degraded: The hub's Lightning node does not answer.";

const settings = (format: AlertWebhookFormat, patch: Partial<WebhookAlertSettings> = {}): WebhookAlertSettings => ({
  url: WEBHOOK_URL,
  format,
  telegramChatId: format === ALERT_WEBHOOK_FORMAT.TELEGRAM ? TELEGRAM_CHAT_ID : null,
  timeoutMs: TIMEOUT_MS,
  ...patch,
});

/** A fetch stand-in that records each request and answers with `status`, or rejects with `error`. */
function mockFetch(answer: { status?: number; error?: Error } = {}) {
  return jest.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    if (answer.error) throw answer.error;
    return new Response(null, { status: answer.status ?? HTTP_OK });
  });
}

describe("alertText", () => {
  it.each<[AlertLevel, string]>([
    ["critical", "[CRITICAL]"],
    ["warning", "[WARNING]"],
    ["resolved", "[RESOLVED]"],
  ])("starts a %s alert with %s, then the title and the detail", (level, mark) => {
    expect(ALERT_LEVEL_MARK[level]).toBe(mark);
    expect(alertText({ ...ALERT, level })).toBe(`${mark} ${ALERT.title}: ${ALERT.detail}`);
  });

  it("reads as one line, like the example in the docs", () => {
    expect(alertText(ALERT)).toBe(ALERT_LINE);
  });
});

describe("webhookBody", () => {
  it("json: is the alert itself", () => {
    expect(webhookBody(ALERT, settings(ALERT_WEBHOOK_FORMAT.JSON))).toEqual(ALERT);
  });

  it("discord: is { content } with the alert's line", () => {
    expect(webhookBody(ALERT, settings(ALERT_WEBHOOK_FORMAT.DISCORD))).toEqual({ content: ALERT_LINE });
  });

  it("slack: is { text } with the alert's line", () => {
    expect(webhookBody(ALERT, settings(ALERT_WEBHOOK_FORMAT.SLACK))).toEqual({ text: ALERT_LINE });
  });

  it("telegram: is { chat_id, text } with the configured chat", () => {
    expect(webhookBody(ALERT, settings(ALERT_WEBHOOK_FORMAT.TELEGRAM))).toEqual({ chat_id: TELEGRAM_CHAT_ID, text: ALERT_LINE });
  });
});

describe("WebhookAlertSink", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(Object.values(ALERT_WEBHOOK_FORMAT))("POSTs the %s body as JSON to the webhook URL", async (format) => {
    const post = mockFetch();
    await new WebhookAlertSink(settings(format), post).send(ALERT);

    expect(post).toHaveBeenCalledTimes(1);
    const [url, init] = post.mock.calls[0] ?? [];
    expect(url).toBe(WEBHOOK_URL);
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(init?.body))).toEqual(webhookBody(ALERT, settings(format)));
  });

  it("gives the request a timeout of ALERT_WEBHOOK_TIMEOUT_MS", async () => {
    const timeout = jest.spyOn(AbortSignal, "timeout");
    const post = mockFetch();

    await new WebhookAlertSink(settings(ALERT_WEBHOOK_FORMAT.JSON), post).send(ALERT);

    expect(timeout).toHaveBeenCalledWith(TIMEOUT_MS);
    expect(post.mock.calls[0]?.[1]?.signal).toBe(timeout.mock.results[0]?.value);
  });

  it("logs nothing when the webhook answers 2xx", async () => {
    await new WebhookAlertSink(settings(ALERT_WEBHOOK_FORMAT.JSON), mockFetch()).send(ALERT);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a non-2xx answer with its status, naming the alert, and does not throw", async () => {
    const sink = new WebhookAlertSink(settings(ALERT_WEBHOOK_FORMAT.SLACK), mockFetch({ status: HTTP_SERVER_ERROR }));

    await expect(sink.send(ALERT)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(`Alert ${ALERT.key} not delivered: the webhook answered ${HTTP_SERVER_ERROR}`);
  });

  it("logs a failed delivery (network error, timeout) with its reason and does not throw", async () => {
    const sink = new WebhookAlertSink(settings(ALERT_WEBHOOK_FORMAT.DISCORD), mockFetch({ error: new Error("The operation was aborted due to timeout") }));

    await expect(sink.send(ALERT)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(`Alert ${ALERT.key} not delivered: The operation was aborted due to timeout`);
  });

  it("does not throw even when fetch throws before returning a promise", async () => {
    const post = jest.fn((): Promise<Response> => {
      throw new TypeError("Invalid URL");
    });

    await expect(new WebhookAlertSink(settings(ALERT_WEBHOOK_FORMAT.JSON), post).send(ALERT)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid URL"));
  });
});

describe("LogAlertSink", () => {
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("logs a critical alert as an error, in the alert's line", async () => {
    await new LogAlertSink().send(ALERT);
    expect(error).toHaveBeenCalledWith(ALERT_LINE);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each<AlertLevel>(["warning", "resolved"])("logs a %s alert as a warning, in the alert's line", async (level) => {
    const alert = { ...ALERT, level };
    await new LogAlertSink().send(alert);
    expect(warn).toHaveBeenCalledWith(alertText(alert));
    expect(error).not.toHaveBeenCalled();
  });
});

describe("AlertsModule (ALERT_SINK)", () => {
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  const sinkFor = async (webhook: WebhookAlertSettings | null): Promise<AlertSink> => {
    moduleRef = await Test.createTestingModule({ imports: [HubConfigModule, AlertsModule] })
      .overrideProvider(HUB_CONFIG)
      .useValue(monitorConfig({ webhook }))
      .compile();
    return moduleRef.get<AlertSink>(ALERT_SINK);
  };

  it("is the log without a webhook", async () => {
    expect(await sinkFor(null)).toBeInstanceOf(LogAlertSink);
  });

  it("is the webhook when config.monitoring.webhook is set", async () => {
    expect(await sinkFor(settings(ALERT_WEBHOOK_FORMAT.DISCORD))).toBeInstanceOf(WebhookAlertSink);
  });
});
