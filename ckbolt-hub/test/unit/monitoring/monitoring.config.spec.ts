import { ALERT_WEBHOOK_FORMAT } from "../../../src/common/constants/monitoring.constants";
import { loadHubConfig, type HubConfig } from "../../../src/config/hub.config";
import { readEnvExample } from "../../support/env-example";
import { minutes, seconds } from "./monitoring.fixtures";

/**
 * The `monitoring` block of HubConfig from MONITOR_* and ALERT_* (docs/monitoring.md, "Settings"), the Telegram check
 * (assertTelegramChat), and the webhook, null without ALERT_WEBHOOK_URL.
 */

const WEBHOOK_URL = "https://alerts.example.com/hook";
const TELEGRAM_URL = "https://api.telegram.org/bot123:abc/sendMessage";
const TELEGRAM_CHAT_ID = "-1001234567890";
/** ALERT_WEBHOOK_TIMEOUT_MS's default. */
const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;

const monitoringOf = (env: Record<string, string> = {}): HubConfig["monitoring"] => loadHubConfig(env).monitoring;

/** Each numeric setting: its variable, its default, and where (and in which unit) the config keeps it. */
const NUMERIC_SETTINGS = [
  { env: "MONITOR_INTERVAL_SECONDS", fallback: 60, toMs: seconds, read: (m: HubConfig["monitoring"]) => m.intervalMs },
  { env: "MONITOR_SETTLE_MINUTES", fallback: 3, toMs: minutes, read: (m: HubConfig["monitoring"]) => m.swapLimits.settleMs },
  { env: "MONITOR_PAYOUT_IN_FLIGHT_MINUTES", fallback: 15, toMs: minutes, read: (m: HubConfig["monitoring"]) => m.swapLimits.payoutInFlightMs },
  { env: "MONITOR_PAYOUT_START_MINUTES", fallback: 5, toMs: minutes, read: (m: HubConfig["monitoring"]) => m.swapLimits.payoutStartMs },
  { env: "MONITOR_REFUND_MINUTES", fallback: 10, toMs: minutes, read: (m: HubConfig["monitoring"]) => m.swapLimits.refundMs },
  { env: "ALERT_REPEAT_MINUTES", fallback: 60, toMs: minutes, read: (m: HubConfig["monitoring"]) => m.repeatMs },
  { env: "MONITOR_FAILED_PASSES", fallback: 3, toMs: (n: number) => n, read: (m: HubConfig["monitoring"]) => m.failedPassesAlert },
];

describe("HubConfig.monitoring", () => {
  describe("defaults", () => {
    it("monitors by default, with no webhook (alerts go to the log)", () => {
      expect(monitoringOf()).toMatchObject({ enabled: true, webhook: null });
    });

    it("has every documented default", () => {
      expect(monitoringOf()).toEqual({
        enabled: true,
        intervalMs: seconds(60),
        repeatMs: minutes(60),
        swapLimits: { settleMs: minutes(3), payoutInFlightMs: minutes(15), payoutStartMs: minutes(5), refundMs: minutes(10) },
        failedPassesAlert: 3,
        webhook: null,
      });
    });

    it.each([...NUMERIC_SETTINGS.map(({ env, fallback }) => [env, String(fallback)]), ["MONITOR_ENABLED", "true"], ["ALERT_WEBHOOK_FORMAT", "json"], ["ALERT_WEBHOOK_TIMEOUT_MS", String(DEFAULT_WEBHOOK_TIMEOUT_MS)]])(
      "documents %s in .env.example as %s",
      (env, value) => {
        expect(readEnvExample()[env]).toBe(value);
      },
    );

    it.each(["ALERT_WEBHOOK_URL", "ALERT_TELEGRAM_CHAT_ID"])("documents %s in .env.example, empty", (env) => {
      expect(readEnvExample()[env]).toBe("");
    });
  });

  describe("MONITOR_* and ALERT_REPEAT_MINUTES", () => {
    it.each(NUMERIC_SETTINGS)("reads $env in its unit", ({ env, toMs, read }) => {
      const VALUE = 7;
      expect(read(monitoringOf({ [env]: String(VALUE) }))).toBe(toMs(VALUE));
    });

    it.each(NUMERIC_SETTINGS.flatMap(({ env }) => ["0", "-1", "1.5", "often"].map((value) => [env, value])))("refuses %s=%p, naming it", (env, value) => {
      expect(() => monitoringOf({ [env]: value })).toThrow(new RegExp(`^Invalid hub configuration: ${env}`));
    });

    it.each([
      ["false", false],
      ["0", false],
      ["no", false],
      ["true", true],
    ])("reads MONITOR_ENABLED=%s as %s", (value, enabled) => {
      expect(monitoringOf({ MONITOR_ENABLED: value }).enabled).toBe(enabled);
    });

    it("refuses a MONITOR_ENABLED that is no boolean", () => {
      expect(() => monitoringOf({ MONITOR_ENABLED: "sometimes" })).toThrow(/^Invalid hub configuration: MONITOR_ENABLED/);
    });
  });

  describe("the webhook (ALERT_WEBHOOK_*)", () => {
    it("is null without ALERT_WEBHOOK_URL, whatever the other ALERT_* say", () => {
      expect(monitoringOf({ ALERT_WEBHOOK_FORMAT: "slack", ALERT_WEBHOOK_TIMEOUT_MS: "1000" }).webhook).toBeNull();
    });

    it("is null with an empty ALERT_WEBHOOK_URL", () => {
      expect(monitoringOf({ ALERT_WEBHOOK_URL: " " }).webhook).toBeNull();
    });

    it("is JSON with the default timeout when only ALERT_WEBHOOK_URL is set", () => {
      expect(monitoringOf({ ALERT_WEBHOOK_URL: WEBHOOK_URL }).webhook).toEqual({ url: WEBHOOK_URL, format: "json", telegramChatId: null, timeoutMs: DEFAULT_WEBHOOK_TIMEOUT_MS });
    });

    it.each(Object.values(ALERT_WEBHOOK_FORMAT).filter((format) => format !== ALERT_WEBHOOK_FORMAT.TELEGRAM))("reads ALERT_WEBHOOK_FORMAT=%s", (format) => {
      expect(monitoringOf({ ALERT_WEBHOOK_URL: WEBHOOK_URL, ALERT_WEBHOOK_FORMAT: format }).webhook?.format).toBe(format);
    });

    it("reads ALERT_WEBHOOK_TIMEOUT_MS", () => {
      const TIMEOUT_MS = 1_500;
      expect(monitoringOf({ ALERT_WEBHOOK_URL: WEBHOOK_URL, ALERT_WEBHOOK_TIMEOUT_MS: String(TIMEOUT_MS) }).webhook?.timeoutMs).toBe(TIMEOUT_MS);
    });

    it.each(["0", "-5", "2.5"])("refuses ALERT_WEBHOOK_TIMEOUT_MS=%p", (value) => {
      expect(() => monitoringOf({ ALERT_WEBHOOK_TIMEOUT_MS: value })).toThrow(/^Invalid hub configuration: ALERT_WEBHOOK_TIMEOUT_MS/);
    });

    it("refuses a format it does not know, listing the known ones", () => {
      expect(() => monitoringOf({ ALERT_WEBHOOK_FORMAT: "teams" })).toThrow(/^Invalid hub configuration: ALERT_WEBHOOK_FORMAT.*json.*discord.*slack.*telegram/);
    });

    it("refuses an ALERT_WEBHOOK_URL that is no URL", () => {
      expect(() => monitoringOf({ ALERT_WEBHOOK_URL: "alerts.example.com/hook" })).toThrow(/^Invalid hub configuration: ALERT_WEBHOOK_URL/);
    });
  });

  describe("Telegram needs a chat (assertTelegramChat)", () => {
    it("refuses ALERT_WEBHOOK_FORMAT=telegram without ALERT_TELEGRAM_CHAT_ID", () => {
      expect(() => monitoringOf({ ALERT_WEBHOOK_URL: TELEGRAM_URL, ALERT_WEBHOOK_FORMAT: "telegram" })).toThrow(
        "Invalid hub configuration: ALERT_WEBHOOK_FORMAT=telegram needs ALERT_TELEGRAM_CHAT_ID",
      );
    });

    it("refuses it with an empty ALERT_TELEGRAM_CHAT_ID", () => {
      expect(() => monitoringOf({ ALERT_WEBHOOK_URL: TELEGRAM_URL, ALERT_WEBHOOK_FORMAT: "telegram", ALERT_TELEGRAM_CHAT_ID: "" })).toThrow(/ALERT_TELEGRAM_CHAT_ID/);
    });

    it("starts with the chat, and keeps it in the webhook settings", () => {
      const webhook = monitoringOf({ ALERT_WEBHOOK_URL: TELEGRAM_URL, ALERT_WEBHOOK_FORMAT: "telegram", ALERT_TELEGRAM_CHAT_ID: TELEGRAM_CHAT_ID }).webhook;
      expect(webhook).toEqual({ url: TELEGRAM_URL, format: "telegram", telegramChatId: TELEGRAM_CHAT_ID, timeoutMs: DEFAULT_WEBHOOK_TIMEOUT_MS });
    });

    it("does not ask for a chat while no webhook is set: nothing is posted", () => {
      expect(monitoringOf({ ALERT_WEBHOOK_FORMAT: "telegram" }).webhook).toBeNull();
    });

    it.each(["json", "discord", "slack"])("does not ask for a chat for the %s format", (format) => {
      expect(monitoringOf({ ALERT_WEBHOOK_URL: WEBHOOK_URL, ALERT_WEBHOOK_FORMAT: format }).webhook?.telegramChatId).toBeNull();
    });
  });
});
