import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from "../../../src/common/constants/protocol.constants";
import type { HubConfig } from "../../../src/config/hub.config";
import { FakeClock } from "../../fakes";
import { createApiApp, makeStubs, spyOnLogger, stubServicesModule, SWAP_ID, testConfig, type ConfigPatch, type Stubs } from "./api.fixtures";

/**
 * Rate limits over HTTP: config.server.rateLimitPerMinute per client on every route, config.demo.maxActionsPerHour per
 * client on the demo routes on top. 429 rate_limited with Retry-After. Client = last X-Forwarded-For entry only behind a
 * trusted proxy, otherwise the socket address.
 */

const FORWARDED_FOR = "X-Forwarded-For";
/** A client that used its whole budget at one instant waits the full minute. */
const RETRY_AFTER_FULL_MINUTE = MS_PER_MINUTE / MS_PER_SECOND;
const demoInvoiceBody = { direction: "fiber_to_ln", asset: "CKB", amount: "1000" };

describe("rate limiting (HTTP)", () => {
  let app: INestApplication | undefined;
  let stubs: Stubs;
  let clock: FakeClock;

  const start = async (patch: ConfigPatch): Promise<HubConfig> => {
    const config = testConfig(patch);
    app = await createApiApp({ config, clock, apiImports: [stubServicesModule(stubs)] });
    return config;
  };
  const http = () => {
    if (!app) throw new Error("app not started");
    return request(app.getHttpServer());
  };
  const getHealth = (forwardedFor?: string) => {
    const req = http().get("/v1/health");
    return forwardedFor === undefined ? req : req.set(FORWARDED_FOR, forwardedFor);
  };

  const expectRateLimited = (res: request.Response): number => {
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: { code: API_ERROR_CODE.RATE_LIMITED, message: expect.any(String) } });
    const retryAfter = Number(res.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    return retryAfter;
  };

  beforeEach(() => {
    spyOnLogger();
    stubs = makeStubs();
    clock = new FakeClock();
    app = undefined;
  });

  afterEach(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });

  describe("global limit (server.rateLimitPerMinute)", () => {
    it("allows exactly the configured number of requests per minute, then answers 429 with Retry-After", async () => {
      await start({ server: { rateLimitPerMinute: 3 } });
      for (let i = 0; i < 3; i += 1) expect((await getHealth()).status).toBe(200);
      const retryAfter = expectRateLimited(await getHealth());
      expect(retryAfter).toBe(RETRY_AFTER_FULL_MINUTE);
    });

    it("counts every route of the API against the same per-client budget", async () => {
      await start({ server: { rateLimitPerMinute: 3 } });
      expect((await http().get("/v1/assets")).status).toBe(200);
      expect((await http().post("/v1/quotes").send({ bad: true })).status).toBe(400);
      expect((await getHealth()).status).toBe(200);
      expectRateLimited(await http().get(`/v1/swaps/${SWAP_ID}`));
      expect(stubs.engine.getSwap).not.toHaveBeenCalled();
    });

    it("a refused request does not reach the controller or the service", async () => {
      await start({ server: { rateLimitPerMinute: 1 } });
      await http().post("/v1/quotes").send({ direction: "ln_to_fiber", asset: "CKB", side: "pay", amount: "1000" });
      expect(stubs.pricing.createQuote).toHaveBeenCalledTimes(1);
      expectRateLimited(await http().post("/v1/quotes").send({ direction: "ln_to_fiber", asset: "CKB", side: "pay", amount: "1000" }));
      expect(stubs.pricing.createQuote).toHaveBeenCalledTimes(1);
    });

    it("the window slides: a request is allowed again once the oldest one is a minute old", async () => {
      await start({ server: { rateLimitPerMinute: 2 } });
      expect((await getHealth()).status).toBe(200);
      clock.advance(30 * MS_PER_SECOND);
      expect((await getHealth()).status).toBe(200);
      clock.advance(29 * MS_PER_SECOND);
      const retryAfter = expectRateLimited(await getHealth());
      expect(retryAfter).toBe(1);
      clock.advance(1 * MS_PER_SECOND);
      expect((await getHealth()).status).toBe(200);
      expectRateLimited(await getHealth());
    });

    it("Retry-After rounds a part second up", async () => {
      await start({ server: { rateLimitPerMinute: 1 } });
      expect((await getHealth()).status).toBe(200);
      clock.advance(MS_PER_MINUTE - 1_500);
      expect(expectRateLimited(await getHealth())).toBe(2);
    });

    it("keeps answering 429 while a client hammers, but refused requests do not extend the wait", async () => {
      await start({ server: { rateLimitPerMinute: 1 } });
      expect((await getHealth()).status).toBe(200);
      for (let i = 0; i < 5; i += 1) {
        clock.advance(10 * MS_PER_SECOND);
        expectRateLimited(await getHealth());
      }
      clock.advance(10 * MS_PER_SECOND);
      expect((await getHealth()).status).toBe(200);
    });

    it("unknown routes are not throttled into 429 (they are 404 regardless)", async () => {
      await start({ server: { rateLimitPerMinute: 1 } });
      expect((await getHealth()).status).toBe(200);
      const res = await http().get("/v1/unknown");
      expect(res.status).toBe(404);
    });
  });

  describe("client key", () => {
    it("without trustProxy, X-Forwarded-For is ignored: forged addresses share the socket's budget", async () => {
      await start({ server: { rateLimitPerMinute: 2, trustProxy: false } });
      expect((await getHealth("203.0.113.1")).status).toBe(200);
      expect((await getHealth("203.0.113.2")).status).toBe(200);
      expectRateLimited(await getHealth("203.0.113.3"));
    });

    it("with trustProxy, each last X-Forwarded-For entry gets its own budget", async () => {
      await start({ server: { rateLimitPerMinute: 1, trustProxy: true } });
      expect((await getHealth("203.0.113.1")).status).toBe(200);
      expect((await getHealth("203.0.113.2")).status).toBe(200);
      expectRateLimited(await getHealth("203.0.113.1"));
      expectRateLimited(await getHealth("203.0.113.2"));
    });

    it("with trustProxy, only the last entry counts: a client cannot dodge the limit by forging earlier entries", async () => {
      await start({ server: { rateLimitPerMinute: 1, trustProxy: true } });
      expect((await getHealth("10.0.0.1, 198.51.100.7")).status).toBe(200);
      expectRateLimited(await getHealth("10.0.0.2, 198.51.100.7"));
      expectRateLimited(await getHealth("198.51.100.7"));
    });

    it("with trustProxy and no header, the socket address is the key", async () => {
      await start({ server: { rateLimitPerMinute: 1, trustProxy: true } });
      expect((await getHealth()).status).toBe(200);
      expectRateLimited(await getHealth());
      expect((await getHealth("198.51.100.9")).status).toBe(200);
    });
  });

  describe("demo limit (demo.maxActionsPerHour)", () => {
    it("invoices and payments share the hourly demo budget; 429 with Retry-After of up to an hour", async () => {
      await start({ server: { rateLimitPerMinute: 1_000 }, demo: { maxActionsPerHour: 2 } });
      expect((await http().post("/v1/demo/invoices").send(demoInvoiceBody)).status).toBe(201);
      expect((await http().post("/v1/demo/payments").send({ swapId: SWAP_ID })).status).toBe(202);
      const retryAfter = expectRateLimited(await http().post("/v1/demo/invoices").send(demoInvoiceBody));
      expect(retryAfter).toBe(MS_PER_HOUR / MS_PER_SECOND);
      expectRateLimited(await http().post("/v1/demo/payments").send({ swapId: SWAP_ID }));
      expect(stubs.demo.createPayoutInvoice).toHaveBeenCalledTimes(1);
      expect(stubs.demo.payHoldInvoice).toHaveBeenCalledTimes(1);
    });

    it("the demo budget does not throttle the rest of the API", async () => {
      await start({ server: { rateLimitPerMinute: 1_000 }, demo: { maxActionsPerHour: 1 } });
      expect((await http().post("/v1/demo/invoices").send(demoInvoiceBody)).status).toBe(201);
      expectRateLimited(await http().post("/v1/demo/invoices").send(demoInvoiceBody));
      expect((await getHealth()).status).toBe(200);
      expect((await http().get("/v1/assets")).status).toBe(200);
    });

    it("the demo budget comes back after an hour", async () => {
      await start({ server: { rateLimitPerMinute: 1_000 }, demo: { maxActionsPerHour: 1 } });
      expect((await http().post("/v1/demo/invoices").send(demoInvoiceBody)).status).toBe(201);
      clock.advance(MS_PER_HOUR - 1);
      expectRateLimited(await http().post("/v1/demo/invoices").send(demoInvoiceBody));
      clock.advance(1);
      expect((await http().post("/v1/demo/invoices").send(demoInvoiceBody)).status).toBe(201);
    });

    it("a disabled demo answers 404 demo_disabled and spends no demo budget", async () => {
      await start({ server: { rateLimitPerMinute: 1_000 }, demo: { maxActionsPerHour: 1 } });
      stubs.demo.enabled = false;
      for (let i = 0; i < 3; i += 1) {
        const res = await http().post("/v1/demo/invoices").send(demoInvoiceBody);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe(API_ERROR_CODE.DEMO_DISABLED);
      }
      stubs.demo.enabled = true;
      expect((await http().post("/v1/demo/invoices").send(demoInvoiceBody)).status).toBe(201);
    });

    it("is per client behind a trusted proxy", async () => {
      await start({ server: { rateLimitPerMinute: 1_000, trustProxy: true }, demo: { maxActionsPerHour: 1 } });
      const post = (ip: string) => http().post("/v1/demo/invoices").set(FORWARDED_FOR, ip).send(demoInvoiceBody);
      expect((await post("203.0.113.10")).status).toBe(201);
      expect((await post("203.0.113.11")).status).toBe(201);
      expectRateLimited(await post("203.0.113.10"));
    });

    it("demo actions also count against the global per-minute budget", async () => {
      await start({ server: { rateLimitPerMinute: 2 }, demo: { maxActionsPerHour: 100 } });
      expect((await http().post("/v1/demo/invoices").send(demoInvoiceBody)).status).toBe(201);
      expect((await getHealth()).status).toBe(200);
      expectRateLimited(await http().post("/v1/demo/invoices").send(demoInvoiceBody));
    });
  });
});
