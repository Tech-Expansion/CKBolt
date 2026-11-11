import { expect, test, type Page } from "@playwright/test";
import { API_ERROR_CODE, HUB_PROXY_ERROR_CODE, type AssetDto } from "../../lib/hub/contract";
import { apiError, FakeHub, hubAsset, installNoHub, RATE } from "./fakes/hub";

/*
 * Independent checks of the web polish: the /app intro without a live hub and with one, USDI gone from the site and the
 * swap card's token list, the price-source copy, and the proxy's error codes as plain sentences. Pages without a hub
 * get a fake that answers 503 hub_unavailable, as the proxy does without HUB_URL; a live hub is the fake of
 * tests/e2e/fakes/hub.ts. Only the request-level proxy test talks to the server's own proxy, so it needs a server
 * without HUB_URL.
 */

const LIGHTNING = { nodes: 16_227, channels: 32_512, capacitySats: 375_373_572_185, asOf: "2026-08-30T00:00:00.000Z", source: "mempool.space" };

async function mockMarketData(page: Page) {
  await page.route("**/api/rate", (route) => route.fulfill({ json: RATE }));
  await page.route("**/api/lightning-stats", (route) => route.fulfill({ json: LIGHTNING }));
}

/* ------------------------------------------------------------------------------------------------ helpers */

type Mode = "receive" | "pay" | "swap";

/** The /app page's mode tabs: rendered once the client bundle has loaded. */
const modeTabs = (page: Page) => page.getByRole("tablist", { name: "Mode" });

/** Opens /app (in one mode, or the default tab) once the client bundle has loaded; without `hub`, a server with none. */
async function openApp(page: Page, hub: FakeHub | null, mode?: Mode) {
  await mockMarketData(page);
  if (hub) await hub.install(page);
  else await installNoHub(page);
  await page.goto(mode ? `/app?mode=${mode}` : "/app");
  // The app loads client-side; allow for a cold server.
  await expect(modeTabs(page)).toBeVisible({ timeout: 20_000 });
}

/** The /app page's eyebrow (the line above the heading), heading and lead (the paragraph below it). */
function intro(page: Page) {
  const heading = page.locator("main h1");
  return {
    heading,
    eyebrow: heading.locator("xpath=preceding-sibling::span[1]"),
    lead: heading.locator("xpath=following-sibling::p[1]"),
  };
}

/** The intro without a live hub (none set up, unreachable, degraded, or the first check pending). */
const IDLE_EYEBROW = "Live testnet demo";
const IDLE_LEAD = "Real swaps with test money, through the CKBolt testnet hub.";
const LIVE_EYEBROW = "Live on testnet: real swaps with test money";
const liveLead = (assets: string) => `Swap BTC on Lightning for ${assets} on Fiber, and back.`;

async function expectIdleIntro(page: Page) {
  const { heading, eyebrow, lead } = intro(page);
  await expect(heading).toHaveCount(1);
  await expect(heading).toHaveText("Pay, get paid, swap.");
  await expect(eyebrow).toHaveText(IDLE_EYEBROW);
  await expect(lead).toHaveText(IDLE_LEAD);
  await expect(page.locator("main")).not.toContainText("Live on testnet: real swaps");
  await expect(page.locator("main")).not.toContainText(/simulat/i);
}

async function expectLiveIntro(page: Page, assets: string) {
  const { heading, eyebrow, lead } = intro(page);
  await expect(heading).toHaveCount(1);
  await expect(heading).toHaveText("Pay, get paid, swap.");
  await expect(eyebrow).toHaveText(LIVE_EYEBROW);
  await expect(lead).toHaveText(liveLead(assets));
  await expect(page.locator("main")).not.toContainText(IDLE_LEAD);
}

const TABS: [RegExp, string][] = [
  [/^Pay/, "mode-pay"],
  [/^Swap/, "mode-swap"],
  [/Get paid/, "mode-receive"],
];

/** The text people can read on the page, hidden panels (closed FAQ answers) included; scripts and styles left out. */
function readableText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.parentElement?.closest("script, style, noscript, template") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const parts: string[] = [];
    while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? "");
    return parts.join(" ").replace(/\s+/g, " ");
  });
}

/** Sentences of `text` that match `pattern`. */
const sentencesWith = (text: string, pattern: RegExp): string[] => text.split(/(?<=[.!?])\s+/).filter((s) => pattern.test(s));

const SITE_PAGES = ["/", "/app?mode=receive", "/app?mode=pay", "/app?mode=swap"];

async function openSitePage(page: Page, path: string) {
  await installNoHub(page);
  await page.goto(path);
  if (path.startsWith("/app")) await expect(page.getByTestId("hub-unavailable").filter({ visible: true })).toBeVisible({ timeout: 20_000 });
  else await expect(page.getByRole("heading", { level: 1 })).toContainText("Pay, get paid, swap.");
}

/* -------------------------------------------------------------------------------------------- /app intro */

test.describe("/app intro: eyebrow and lead", () => {
  test("without a hub the intro says what the app does on every tab, which says the hub is not available; nothing is simulated", async ({ page }) => {
    const health = page.waitForResponse((r) => r.url().endsWith("/api/hub/v1/health"));
    await openApp(page, null);
    // The hub answered 503 hub_unavailable (as the proxy does without HUB_URL) before the intro is checked: the settled state.
    expect((await health).status()).toBe(503);
    await expectIdleIntro(page);
    for (const [tab, panel] of TABS) {
      await page.getByRole("tab", { name: tab }).click();
      await expect(page.getByTestId(panel).getByTestId("hub-unavailable")).toBeVisible();
      await expectIdleIntro(page);
    }
    const description = await page.locator('meta[name="description"]').getAttribute("content");
    expect(description).not.toMatch(/no funds move|simulat/i);
    expect(description).toContain("through the CKBolt testnet hub");
  });

  test("the default wording is already in the server-rendered page, before any hub answer", async ({ request }) => {
    const html = await (await request.get("/app")).text();
    expect(html).toContain(IDLE_EYEBROW);
    expect(html).toContain(IDLE_LEAD);
    expect(html).not.toContain(LIVE_EYEBROW);
  });

  test("a live hub turns the intro live and opens on Swap, asked once for the intro and the swap card together", async ({ page }) => {
    const hub = new FakeHub();
    await openApp(page, hub);
    await expect(page.getByRole("tab", { name: /^Swap/ })).toHaveAttribute("aria-selected", "true");
    await expectLiveIntro(page, "CKB or RUSD");
    for (const [tab, panel] of TABS) {
      await page.getByRole("tab", { name: tab }).click();
      await expect(page.getByTestId(panel)).toBeVisible();
      await expectLiveIntro(page, "CKB or RUSD");
    }
    // The Swap tab agrees with the intro: it is the live swap card.
    await expect(page.getByTestId("mode-swap").getByTestId("swap-card")).toBeAttached();
    // Pay and Get paid are their cards.
    await page.getByRole("tab", { name: /^Pay/ }).click();
    await expect(page.getByTestId("mode-pay").getByTestId("pay-card")).toBeVisible();
    await page.getByRole("tab", { name: /^Get paid/ }).click();
    await expect(page.getByTestId("mode-receive").getByTestId("request-card")).toBeVisible();
    expect(hub.count("GET /v1/health")).toBe(1);
    expect(hub.count("GET /v1/assets")).toBe(1);
  });

  const assetCases: { name: string; assets: AssetDto[]; phrase: string }[] = [
    { name: "one asset", assets: [hubAsset("CKB")], phrase: "CKB" },
    { name: "three assets, with the hub's own symbol for cWBTC", assets: [hubAsset("CKB"), hubAsset("RUSD"), hubAsset("CWBTC", ["ln_to_fiber"])], phrase: "CKB, RUSD, or cWBTC" },
    { name: "an asset listed with no direction is left out", assets: [hubAsset("CKB"), hubAsset("RUSD", [])], phrase: "CKB" },
    { name: "an asset served one way only still counts", assets: [hubAsset("RUSD", ["fiber_to_ln"])], phrase: "RUSD" },
  ];
  for (const { name, assets, phrase } of assetCases) {
    test(`the live lead names the assets the hub swaps (/v1/assets): ${name}`, async ({ page }) => {
      const hub = new FakeHub();
      hub.assets = assets;
      await openApp(page, hub, "swap");
      await expectLiveIntro(page, phrase);
    });
  }

  test("while the first hub check is pending the intro keeps the default wording and the tab says it is checking, then turns live", async ({ page }) => {
    const hub = new FakeHub();
    hub.latencyMs.set("GET /v1/health", 3_000);
    await mockMarketData(page);
    await hub.install(page);
    await page.goto("/app?mode=swap");
    await expect(modeTabs(page)).toBeVisible({ timeout: 20_000 });
    // The health check has not answered yet.
    expect(hub.count("GET /v1/assets")).toBe(0);
    await expect(intro(page).eyebrow).toHaveText(IDLE_EYEBROW);
    await expect(intro(page).lead).toHaveText(IDLE_LEAD);
    await expect(page.getByTestId("mode-swap").getByTestId("hub-checking")).toHaveText("Checking the CKBolt testnet hub…");
    await expectLiveIntro(page, "CKB or RUSD");
    await expect(page.getByTestId("mode-swap").getByTestId("swap-card")).toBeVisible();
  });

  test("a degraded hub keeps the default wording, and the tab says why behind a ?", async ({ page }) => {
    const hub = new FakeHub();
    hub.healthStatus = 503;
    hub.health = {
      ...hub.health,
      status: "degraded",
      reason: "The hub's Lightning node is not reachable.",
      lightning: { ...hub.health.lightning, reachable: false, synced: false },
    };
    await openApp(page, hub, "swap");
    // The hub's answer has arrived: the tab says it is not taking swaps.
    const degraded = page.getByTestId("mode-swap").getByTestId("hub-degraded");
    await expect(degraded).toContainText("The CKBolt testnet hub is reachable but not taking swaps right now.");
    await degraded.getByRole("button", { name: "Why the hub is not taking swaps" }).click();
    await expect(page.getByRole("dialog", { name: "Why the hub is not taking swaps" })).toContainText("The hub's Lightning node is not reachable.");
    await expectIdleIntro(page);
    expect(hub.count("GET /v1/assets")).toBe(0);
  });

  test("a healthy hub whose assets cannot be read, or that swaps nothing, keeps the default wording", async ({ page }) => {
    const broken = new FakeHub();
    broken.fail("GET /v1/assets", { status: 500, body: apiError(API_ERROR_CODE.INTERNAL, "Something went wrong on the hub.") });
    await openApp(page, broken, "swap");
    await expect(page.getByTestId("mode-swap").getByTestId("hub-degraded")).toBeVisible();
    await expectIdleIntro(page);

    await page.unrouteAll({ behavior: "ignoreErrors" });
    const idle = new FakeHub();
    idle.assets = [hubAsset("CKB", []), hubAsset("RUSD", [])];
    await openApp(page, idle, "swap");
    await expect(page.getByTestId("mode-swap").getByTestId("hub-degraded")).toBeVisible();
    await expectIdleIntro(page);
  });

  test("a hub that cannot be reached keeps the default wording, and every tab says it is not available", async ({ page }) => {
    await mockMarketData(page);
    await page.route("**/api/hub/**", (route) => route.abort("connectionrefused"));
    await page.goto("/app?mode=swap");
    await expect(modeTabs(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("mode-swap").getByTestId("hub-unavailable")).toBeVisible({ timeout: 20_000 });
    await expectIdleIntro(page);
  });
});

/* ------------------------------------------------------------------------------------------------- USDI */

test.describe("USDI is gone from the site", () => {
  test("no page names USDI, in its text, markup or metadata, and no USDI icon is asked for", async ({ page }) => {
    await mockMarketData(page);
    const usdiRequests: string[] = [];
    page.on("request", (r) => {
      if (/usdi/i.test(r.url())) usdiRequests.push(r.url());
    });
    for (const path of SITE_PAGES) {
      await openSitePage(page, path);
      const html = await page.content();
      expect(html.match(/.{0,40}usdi.{0,40}/gi) ?? [], path).toEqual([]);
    }
    expect(usdiRequests).toEqual([]);
  });

  test("the USDI icon file is no longer served", async ({ request }) => {
    expect((await request.get("/tokens/usdi.svg")).status()).toBe(404);
    // The icons that stay are still there.
    expect((await request.get("/tokens/ckb.svg")).status()).toBe(200);
  });

  test("the swap card's token list offers the hub's assets only, never USDI", async ({ page }) => {
    await openApp(page, new FakeHub(), "swap");
    const swap = page.getByTestId("mode-swap");
    await swap.getByTestId("swap-token-receive").click();
    const list = page.getByTestId("swap-token-list");
    await expect(list.getByRole("button")).toHaveCount(2);
    await expect(list.getByRole("button").nth(0)).toContainText("CKB");
    await expect(list.getByRole("button").nth(1)).toContainText("RUSD");
    await expect(list).not.toContainText("USDI");
  });

});

/* ------------------------------------------------------------------------------------------ price source */

test.describe("price-source copy", () => {
  test("the FAQ answer: reference prices for the page's examples, a median plus spread on a live hub, RUSD at its peg, no CKB DEX or oracle", async ({ page }) => {
    await mockMarketData(page);
    await installNoHub(page);
    await page.goto("/");
    const question = page.getByRole("button", { name: "Where do prices come from, and how does CKBolt earn?" });
    await question.click();
    await expect(question).toHaveAttribute("aria-expanded", "true");
    const answer = page.locator(`#${await question.getAttribute("aria-controls")}`);
    await expect(answer).toBeVisible();
    await expect(answer).toHaveText(
      "The examples on this page use CoinGecko, Binance and KuCoin reference prices. A live hub quotes from the median of those exchange prices, with its spread on top, and RUSD at its $1 peg. No CKB DEX or oracle gives a usable price today: UTXOSwap shut down in October 2026. CKBolt earns the spread on each route.",
    );
  });

  test("the roadmap's stage 3 promises firm quotes from a median of exchange prices plus the hub's spread", async ({ page }) => {
    await mockMarketData(page);
    await installNoHub(page);
    await page.goto("/");
    const roadmap = page.locator("#roadmap");
    await expect(roadmap.getByText("Firm quotes signed by the hub, from a median of exchange prices plus its spread, paid from its own liquidity", { exact: true })).toHaveCount(1);
  });

  test("no page claims a decentralized price source, a DEX price or an oracle price", async ({ page }) => {
    await mockMarketData(page);
    for (const path of SITE_PAGES) {
      await openSitePage(page, path);
      const text = await readableText(page);
      expect(sentencesWith(text, /decentrali[sz]ed price/i), path).toEqual([]);
      for (const s of sentencesWith(text, /oracle/i)) expect(s, path).toMatch(/no CKB DEX or oracle gives a usable price today/i);
      for (const s of sentencesWith(text, /UTXOSwap/i)) expect(s, path).toMatch(/UTXOSwap shut down in October 2026/);
    }
  });
});

/* ------------------------------------------------------------------------------- error codes as sentences */

test.describe("hub error codes are shown as plain sentences", () => {
  test("the real proxy answers its codes with plain sentences", async ({ request }) => {
    const sentence = /^[A-Z][^_]*\.$/;
    const cases: { method: string; path: string; status: number; code: string; message: string }[] = [
      { method: "GET", path: "v1/health", status: 503, code: HUB_PROXY_ERROR_CODE.HUB_UNAVAILABLE, message: "Live swaps are not set up on this server." },
      { method: "POST", path: "v1/health", status: 405, code: HUB_PROXY_ERROR_CODE.METHOD_NOT_ALLOWED, message: "This method is not allowed on this hub API path." },
      { method: "GET", path: "v1/admin", status: 404, code: API_ERROR_CODE.NOT_FOUND, message: "This is not a CKBolt hub API path." },
    ];
    for (const c of cases) {
      const res = await request.fetch(`/api/hub/${c.path}`, { method: c.method });
      expect(res.status(), `${c.method} ${c.path}`).toBe(c.status);
      const body = await res.json();
      expect(body, `${c.method} ${c.path}`).toEqual({ error: { code: c.code, message: c.message } });
      expect(body.error.message).toMatch(sentence);
    }
  });
});
