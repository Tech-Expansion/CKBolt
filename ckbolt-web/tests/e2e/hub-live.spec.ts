import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { apiError, FakeHub, fastForward, hubAsset, installNoHub, RATE } from "./fakes/hub";
import { expectNoHorizontalOverflow, expectNoSeriousAxe } from "./page-checks";

/*
 * The /app page with and without a live CKBolt hub. Every /api/hub/** call is answered by a fake hub
 * (tests/e2e/fakes/hub.ts) in the shape of the hub's REST API v1, except in the tests that check the server's own proxy
 * without HUB_URL. A live hub turns the Swap tab into the live swap card (components/app/swap, docs/live-swap-ui.md);
 * without one every tab says the hub is not available, in one line (docs/pay-get-paid.md, part D). This file checks
 * when the page shows what; the card's own behaviour has its own spec.
 */

/* ------------------------------------------------------------------------------------------------ helpers */

const modeTabs = (page: Page) => page.getByRole("tablist", { name: "Mode" });
const tab = (page: Page, name: RegExp) => page.getByRole("tab", { name });
const TAB = { receive: /Get paid/, pay: /^Pay/, swap: /^Swap/ } as const;
const HUB_UNAVAILABLE = "The CKBolt testnet hub is not available right now. Try again later.";
const HUB_DEGRADED = "The CKBolt testnet hub is reachable but not taking swaps right now.";

async function routeRate(page: Page) {
  await page.route("**/api/rate", (route) => route.fulfill({ json: RATE }));
}

/** Opens the Swap tab without a live hub and waits until the hub's answer is on screen (one line, `testId`). */
async function openSwap(page: Page, hub: FakeHub | null, testId: "hub-unavailable" | "hub-degraded", opts: { clock?: boolean } = {}): Promise<Locator> {
  if (opts.clock) await page.clock.install();
  await routeRate(page);
  if (hub) await hub.install(page);
  await page.goto("/app?mode=swap");
  const panel = page.getByTestId("mode-swap");
  // The app loads client-side; allow for a cold server.
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByTestId(testId)).toBeVisible({ timeout: 20_000 });
  return panel;
}

/** Opens `path` against a live fake hub and waits until the page has turned live (the swap card is mounted). */
async function openLive(page: Page, hub: FakeHub, path = "/app", opts: { clock?: boolean } = {}) {
  if (opts.clock) await page.clock.install();
  await routeRate(page);
  await hub.install(page);
  await page.goto(path);
  await expect(modeTabs(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("swap-card")).toBeAttached({ timeout: 20_000 });
}

/** Without a live hub: three tabs, titles only; the panel shows the hub's one line and nothing else of a form. */
async function expectNoLiveHub(panel: Locator) {
  const page = panel.page();
  await expect(page.getByTestId("swap-card")).toHaveCount(0);
  await expect(modeTabs(page).getByRole("tab")).toHaveText(["Get paid", "Pay", "Swap"]);
  await expect(panel.getByRole("button")).toHaveCount(await panel.getByTestId("info-tip").count());
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await expect(panel).not.toContainText(/simulat|stage 3|Execute swap/i);
  await expectNoWallets(page);
}

/** No L1 wallet panel (CCC: CKB and Bitcoin wallets) on /app, whatever the hub. */
async function expectNoWallets(page: Page) {
  for (const id of ["ckb-wallet", "btc-wallet"]) await expect(page.getByTestId(id)).toHaveCount(0);
  await expect(page.locator("ccc-connector")).toHaveCount(0);
}

/* ------------------------------------------------------------------------------------ a live hub */

test.describe("the page with a live hub", () => {
  test("opens on Swap with the live swap card: no L1 wallets, no demo wallet; Pay and Get paid are their cards", async ({ page }) => {
    const hub = new FakeHub();
    await openLive(page, hub);
    await expect(tab(page, TAB.swap)).toHaveAttribute("aria-selected", "true");
    const swap = page.getByTestId("mode-swap");
    await expect(swap.getByTestId("swap-card")).toBeVisible();
    // History is the Fiber node's (the header's popup), not a tab of the app.
    await expect(modeTabs(page).getByRole("tab")).toHaveText(["Get paid", "Pay", "Swap"]);
    await expectNoWallets(page);
    await expect(swap.getByRole("button", { name: /demo wallet/i })).toHaveCount(0);
    expect(hub.count("GET /v1/health")).toBe(1);
    expect(hub.count("GET /v1/assets")).toBe(1);

    // Pay and Get paid: their cards (tests/e2e/pay.spec.ts, tests/e2e/get-paid.spec.ts), no L1 wallets.
    await tab(page, TAB.pay).click();
    await expect(page.getByTestId("mode-pay").getByTestId("pay-card")).toBeVisible();
    await expectNoWallets(page);
    await tab(page, TAB.receive).click();
    const receive = page.getByTestId("mode-receive");
    await expect(receive.getByTestId("request-card")).toBeVisible();
    await expect(receive.getByTestId("hub-unavailable")).toHaveCount(0);
    await expectNoWallets(page);
    await tab(page, TAB.swap).click();
    await expect(swap.getByTestId("swap-card")).toBeVisible();
    // Nothing asked the hub's demo wallet for anything.
    expect(hub.requests.filter((r) => r.includes("/v1/demo/"))).toEqual([]);
  });

  test("a deep link to another tab, or a tab picked before the hub answers, is kept when the hub turns live", async ({ page }) => {
    const hub = new FakeHub();
    await openLive(page, hub, "/app?mode=pay");
    await expect(tab(page, TAB.pay)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("mode-pay").getByTestId("pay-card")).toBeVisible();

    await page.unrouteAll({ behavior: "ignoreErrors" });
    const slow = new FakeHub();
    slow.latencyMs.set("GET /v1/health", 3_000);
    await routeRate(page);
    await slow.install(page);
    await page.goto("/app");
    await expect(modeTabs(page)).toBeVisible({ timeout: 20_000 });
    expect(slow.count("GET /v1/assets")).toBe(0);
    await tab(page, TAB.receive).click();
    await expect(page.getByTestId("mode-receive").getByTestId("hub-checking")).toBeVisible();
    await expect(page.getByTestId("swap-card")).toBeAttached({ timeout: 20_000 });
    await expect(tab(page, TAB.receive)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("mode-receive").getByTestId("request-card")).toBeVisible();
  });

  test("a live hub is checked again every minute, and the Swap tab says the hub is gone when it stops answering", async ({ page }) => {
    const hub = new FakeHub();
    await openLive(page, hub, "/app", { clock: true });
    await fastForward(page, hub, 61_000);
    await expect.poll(() => hub.count("GET /v1/health")).toBe(2);
    await expect(page.getByTestId("swap-card")).toBeVisible();
    hub.fail("GET /v1/health", { abort: true });
    await fastForward(page, hub, 61_000);
    await expect(page.getByTestId("swap-card")).toHaveCount(0);
    const panel = page.getByTestId("mode-swap");
    await expect(panel.getByTestId("hub-unavailable")).toHaveText(HUB_UNAVAILABLE);
    await expectNoLiveHub(panel);
  });

  test("nothing is wider than the screen and no serious axe violations, on Swap and on Get paid", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openLive(page, new FakeHub());
    await expect(page.getByTestId("swap-card")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousAxe(page);
    await tab(page, TAB.receive).click();
    await expect(page.getByTestId("mode-receive").getByTestId("request-card")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousAxe(page);
  });
});

/* ------------------------------------------------------------------------------------ no live hub */

test.describe("the page without a live hub", () => {
  test("a hub that answers 503 hub_unavailable: one line on every tab, and it is not asked again", async ({ page }) => {
    const hub = new FakeHub();
    hub.fail("GET /v1/health", { status: 503, body: apiError("hub_unavailable", "Live swaps are not set up on this server.") });
    const panel = await openSwap(page, hub, "hub-unavailable", { clock: true });
    await expect(panel.getByTestId("hub-unavailable")).toHaveText(HUB_UNAVAILABLE);
    await expectNoLiveHub(panel);
    for (const [name, id] of [
      [TAB.receive, "mode-receive"],
      [TAB.pay, "mode-pay"],
    ] as const) {
      await tab(page, name).click();
      await expect(page.getByTestId(id).getByTestId("hub-unavailable")).toHaveText(HUB_UNAVAILABLE);
    }
    await fastForward(page, hub, 130_000);
    expect(hub.count("GET /v1/health")).toBe(1);
    expect(hub.count("GET /v1/assets")).toBe(0);
    expect(hub.count("POST /v1/quotes")).toBe(0);
  });

  test("a hub that cannot be reached at all: the same line", async ({ page }) => {
    const hub = new FakeHub();
    hub.fail("GET /v1/health", { abort: true });
    const panel = await openSwap(page, hub, "hub-unavailable");
    await expectNoLiveHub(panel);
    expect(hub.count("POST /v1/quotes")).toBe(0);
  });

  test("a server that has no hub opens on Get paid, with the same three tabs and no wallets", async ({ page }) => {
    await routeRate(page);
    await installNoHub(page);
    await page.goto("/app");
    await expect(modeTabs(page)).toBeVisible({ timeout: 20_000 });
    await expect(tab(page, TAB.receive)).toHaveAttribute("aria-selected", "true");
    const panel = page.getByTestId("mode-receive");
    await expect(panel.getByTestId("hub-unavailable")).toBeVisible({ timeout: 20_000 });
    await expectNoLiveHub(panel);
  });

  test("without HUB_URL the real proxy answers 503 and the Swap tab says the hub is not available", async ({ page }) => {
    const health = page.waitForResponse((r) => r.url().endsWith("/api/hub/v1/health"));
    const panel = await openSwap(page, null, "hub-unavailable");
    const res = await health;
    expect(res.status()).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "hub_unavailable", message: "Live swaps are not set up on this server." } });
    await expectNoLiveHub(panel);
  });

  test("a reachable but degraded hub says so, with the hub's reason behind a ?", async ({ page }) => {
    const hub = new FakeHub();
    hub.healthStatus = 503;
    hub.health = { ...hub.health, status: "degraded", reason: "The hub's Fiber node does not answer.", fiber: { reachable: false, network: null, version: null } };
    const panel = await openSwap(page, hub, "hub-degraded");
    await expect(panel.getByTestId("hub-degraded")).toHaveText(HUB_DEGRADED);
    await panel.getByRole("button", { name: "Why the hub is not taking swaps" }).click();
    await expect(page.getByRole("dialog", { name: "Why the hub is not taking swaps" })).toContainText("The hub's Fiber node does not answer.");
    await page.keyboard.press("Escape");
    await expectNoLiveHub(panel);
    expect(hub.count("GET /v1/assets")).toBe(0);
  });

  test("a healthy hub with nothing to swap, or whose assets cannot be read, is degraded", async ({ page }) => {
    const hub = new FakeHub();
    hub.assets = [hubAsset("CKB", []), hubAsset("RUSD", [])];
    const panel = await openSwap(page, hub, "hub-degraded");
    await expectNoLiveHub(panel);

    const broken = new FakeHub();
    broken.fail("GET /v1/assets", { status: 500, raw: "<html>oops</html>" });
    await page.unrouteAll();
    const again = await openSwap(page, broken, "hub-degraded");
    await expectNoLiveHub(again);
  });

  test("the hub's states fit a phone and have no serious axe finding", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const hub = new FakeHub();
    hub.healthStatus = 503;
    hub.health = { ...hub.health, status: "degraded", reason: "The hub's Lightning node is still syncing its chain." };
    await openSwap(page, hub, "hub-degraded");
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousAxe(page);
  });
});

/* ------------------------------------------------------------------------------------------------- proxy */

test.describe("hub proxy on the server under test (no HUB_URL)", () => {
  test("every path the app calls answers 503 hub_unavailable, never cached", async ({ request }) => {
    const id = randomUUID();
    const pubkey = "02" + "ab".repeat(32);
    const calls: [string, string][] = [
      ["GET", "v1/health"],
      ["GET", "v1/assets"],
      ["POST", "v1/quotes"],
      ["POST", "v1/swaps"],
      ["GET", `v1/swaps/${id}`],
      ["GET", `v1/swaps/${id}/events`],
      ["POST", `v1/swaps/${id}/cancel`],
      ["GET", "v1/fiber/node"],
      ["POST", "v1/fiber/inbound-channels"],
      ["GET", `v1/fiber/inbound-channels/${pubkey}`],
      ["GET", "v1/lightning/node"],
      ["POST", "v1/lightning/inbound-channels"],
      ["GET", `v1/lightning/inbound-channels/${pubkey}`],
    ];
    for (const [method, path] of calls) {
      const res = await request.fetch(`/api/hub/${path}`, { method, data: method === "POST" ? {} : undefined });
      expect(res.status(), `${method} ${path}`).toBe(503);
      expect(res.headers()["cache-control"]).toContain("no-store");
      expect(await res.json()).toEqual({ error: { code: "hub_unavailable", message: "Live swaps are not set up on this server." } });
    }
  });

  test("CSRF: another site's no-cors text/plain POST is refused with 403 in a real browser; the app's own JSON POST passes", async ({ page, baseURL }) => {
    const quotes = `${baseURL}/api/hub/v1/quotes`;
    const body = JSON.stringify({ direction: "fiber_to_ln", asset: "CKB", side: "pay", amount: "800000000000" });
    // Another site: this same server under another host name, which the browser counts as a different site.
    const otherSite = baseURL!.replace("localhost", "127.0.0.1");
    expect(otherSite).not.toBe(baseURL);
    await page.goto(`${otherSite}/api/hub/v1/admin`);
    const forged = page.waitForResponse(quotes);
    await page.evaluate(
      ({ url, body }) => {
        // The exploit: no preflight, a text/plain body, and an answer the page cannot read anyway.
        void fetch(url, { method: "POST", mode: "no-cors", body }).catch(() => undefined);
      },
      { url: quotes, body },
    );
    const res = await forged;
    expect((await res.request().allHeaders())["content-type"]).toMatch(/^text\/plain/);
    // 403 from the guard, not the 503 of the missing hub. The body of a no-cors answer is opaque even to the test; the
    // next test checks each refusal's sentence.
    expect(res.status()).toBe(403);

    // The app's own page: same origin, JSON. It passes the guard and meets the missing hub.
    await page.goto(`${baseURL}/api/hub/v1/admin`);
    const own = await page.evaluate(
      async ({ url, body }) => {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
        return { status: r.status, body: await r.json() };
      },
      { url: quotes, body },
    );
    expect(own).toEqual({ status: 503, body: { error: { code: "hub_unavailable", message: "Live swaps are not set up on this server." } } });
  });

  test("CSRF: a write that is not JSON, or says it comes from another site, is a 403 forbidden from the server", async ({ request }) => {
    const notJson = "Requests to the hub must send JSON.";
    const crossSite = "Requests to the hub must come from this site.";
    const cases: { headers: Record<string, string>; message: string }[] = [
      { headers: { "content-type": "text/plain;charset=UTF-8" }, message: notJson },
      { headers: { "content-type": "application/x-www-form-urlencoded" }, message: notJson },
      { headers: { "content-type": "application/json", origin: "https://evil.example" }, message: crossSite },
      { headers: { "content-type": "application/json", origin: "null" }, message: crossSite },
      { headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, message: crossSite },
      { headers: { "content-type": "application/json", "sec-fetch-site": "same-site" }, message: crossSite },
    ];
    for (const path of ["v1/quotes", "v1/swaps", "v1/fiber/inbound-channels", "v1/lightning/inbound-channels"]) {
      for (const c of cases) {
        const res = await request.post(`/api/hub/${path}`, { headers: c.headers, data: "{}" });
        expect(res.status(), `${path} ${JSON.stringify(c.headers)}`).toBe(403);
        expect(res.headers()["cache-control"]).toContain("no-store");
        expect(await res.json()).toEqual({ error: { code: "forbidden", message: c.message } });
      }
    }
  });

  test("anything the app does not call is 404, the hub's demo wallet included, and a wrong method is 405 with Allow", async ({ request }) => {
    const id = randomUUID();
    for (const path of [
      "v1/admin",
      "v2/health",
      "health",
      "v1/swaps/not-a-uuid",
      `v1/swaps/${id}/events/x`,
      "v1/swaps/not-a-uuid/cancel",
      `v1/swaps/${id}/cancel/x`,
      "v1/swaps/%2e%2e/%2e%2e/admin",
      "v1/demo",
      `v1/quotes/${id}`,
    ]) {
      const res = await request.get(`/api/hub/${path}`);
      expect(res.status(), path).toBe(404);
      expect((await res.json()).error.code).toBe("not_found");
    }
    // The demo wallet's routes are refused before the hub, whatever the method (S2).
    for (const path of ["v1/demo/invoices", "v1/demo/payments"]) {
      for (const method of ["POST", "GET", "PUT"]) {
        const res = await request.fetch(`/api/hub/${path}`, { method, data: method === "GET" ? undefined : {} });
        expect(res.status(), `${method} ${path}`).toBe(404);
        expect((await res.json()).error).toEqual({ code: "not_found", message: "This is not a CKBolt hub API path." });
      }
    }
    const wrong: [string, string, string][] = [
      ["POST", "v1/health", "GET"],
      ["GET", "v1/quotes", "POST"],
      ["DELETE", `v1/swaps/${id}`, "GET"],
      ["GET", `v1/swaps/${id}/cancel`, "POST"],
      ["PUT", "v1/lightning/inbound-channels", "POST"],
      ["PATCH", "v1/assets", "GET"],
    ];
    for (const [method, path, allow] of wrong) {
      const res = await request.fetch(`/api/hub/${path}`, { method });
      expect(res.status(), `${method} ${path}`).toBe(405);
      expect(res.headers()["allow"]).toBe(allow);
      expect((await res.json()).error.code).toBe("method_not_allowed");
    }
  });
});

/* -------------------------------------------------------------------------------------------- copy fixes */

test.describe("copy fixes on the site", () => {
  test("the FAQ says Fiber's minimum hold is 160 minutes, and no page says 16 hours", async ({ page }) => {
    await routeRate(page);
    await installNoHub(page);
    await page.goto("/");
    await page.getByRole("button", { name: "What if a payment fails?" }).click();
    const answer = page.locator("#faq").getByText(/the funds return when the hold expires/);
    await expect(answer).toContainText("at least 160 minutes on Fiber");
    expect(await page.locator("body").textContent()).not.toMatch(/16 hours/);
    await page.goto("/app");
    expect(await page.locator("body").textContent()).not.toMatch(/16 hours/);
  });

  test("the FAQ says how a live hub prices: a median of exchange prices with its spread, no CKB DEX or oracle", async ({ page }) => {
    await routeRate(page);
    await installNoHub(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Where do prices come from, and how does CKBolt earn?" }).click();
    const answer = page.locator("#faq").getByText(/A live hub quotes from the median/);
    await expect(answer).toContainText("median of those exchange prices, with its spread on top");
    await expect(answer).toContainText("No CKB DEX or oracle gives a usable price today: UTXOSwap shut down in October 2026.");
    await expect(answer).not.toContainText("checked against");
  });

  test("the hero rotation offers CKB, BTC and RUSD, not USDI", async ({ page }) => {
    await page.clock.install();
    await routeRate(page);
    await installNoHub(page);
    await page.goto("/");
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toContainText("Pay, get paid, swap.");
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const text = (await h1.textContent()) ?? "";
      seen.add(text.replace("Pay, get paid, swap.", "").replace(/^\s*In\s*/, "").trim());
      await page.clock.fastForward(2_600);
    }
    expect([...seen].sort()).toEqual(["BTC", "CKB", "RUSD"]);
  });
});
