import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/*
 * The site around the app: the landing page, its header, footer and API routes, and /app on a server without a CKBolt
 * hub (no HUB_URL here, so the real proxy answers 503): every tab says the hub is not available, with nothing simulated
 * and no wallet on the page. The live swap card is tests/e2e/live-swap.spec.ts.
 */

// Fixed market data so the landing page's figures are deterministic.
// 1 BTC = 40,000,000 CKB and 1 ETH = 1,250,000 CKB.
const RATE = { btcUsd: 80_000, ethUsd: 2_500, ckbUsd: 0.002, source: "Test fixture", updatedAt: Date.now() };

const LIGHTNING = { nodes: 16_227, channels: 32_512, capacitySats: 375_373_572_185, asOf: "2026-08-30T00:00:00.000Z", source: "mempool.space" };

type Mode = "receive" | "pay" | "swap";
const MODES: readonly Mode[] = ["receive", "pay", "swap"];

/** The line every tab shows on a server without a hub. */
const HUB_UNAVAILABLE = "The CKBolt testnet hub is not available right now. Try again later.";

/** Opens /app in one mode and returns that mode's panel, once the hub check has answered. */
async function openApp(page: Page, mode: Mode): Promise<Locator> {
  await page.goto(`/app?mode=${mode}`);
  const panel = page.getByTestId(`mode-${mode}`);
  // The app loads client-side; allow for a cold server.
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByTestId("hub-unavailable")).toBeVisible({ timeout: 20_000 });
  return panel;
}

/** Every element must fit the viewport width; this is what caught clipped text on phones. */
async function expectNoHorizontalOverflow(page: Page) {
  const overflowing = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const el of document.querySelectorAll("main *, section *")) {
      if (el.closest("[class*=marquee]")) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || el.children.length) continue;
      if (getComputedStyle(el).display === "none") continue;
      // Inside a horizontally scrollable box (code samples) is fine.
      let p = el.parentElement;
      let scrolls = false;
      while (p) {
        const o = getComputedStyle(p).overflowX;
        if (o === "auto" || o === "scroll") {
          scrolls = true;
          break;
        }
        p = p.parentElement;
      }
      if (!scrolls && r.right > vw + 1 && (el.textContent ?? "").trim()) out.push(`${el.tagName} "${(el.textContent ?? "").trim().slice(0, 40)}"`);
    }
    return out.slice(0, 10);
  });
  expect(overflowing).toEqual([]);
}

test("landing page links to the app", async ({ page, isMobile }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/CKBolt/);
  if (isMobile) await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("link", { name: "Open the app" }).filter({ visible: true }).last().click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pay, get paid, swap.");
  // Without a live hub the page opens on Get paid.
  await expect(page.getByRole("tab", { name: /Get paid/ })).toHaveAttribute("aria-selected", "true");
});

test("the header links to the testnet guide next to Open the app, with the Fiber node button beside them, on a phone too", async ({ page, isMobile }) => {
  const openMenu = async () => {
    if (isMobile) await page.getByRole("button", { name: "Open menu" }).click();
  };
  const link = (name: string) => page.locator("header").getByRole("link", { name, exact: true }).filter({ visible: true });
  await page.goto("/");
  // The wallet button sits in the header's bar on every width, not in the phone's menu.
  const wallet = page.locator("header").getByTestId("fiber-wallet-button");
  await expect(wallet).toBeVisible();
  await expect(wallet).toHaveText("Fiber node");
  await openMenu();
  await expect(link("Guide")).toHaveAttribute("href", "/app/guide");
  await expect(link("Open the app")).toHaveAttribute("href", "/app");
  // The node page is no longer a header link: the Fiber node button replaced it.
  await expect(page.locator("header").getByRole("link", { name: "Fiber node", exact: true })).toHaveCount(0);
  await link("Guide").click();
  await expect(page).toHaveURL(/\/app\/guide$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Try a live swap.");
});

test("the node page keeps plain links and shows no wallet button: it runs the node itself", async ({ page, isMobile }) => {
  await page.goto("/app/fiber");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your Fiber node.");
  await expect(page.getByTestId("fiber-wallet-button")).toHaveCount(0);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  if (isMobile) await page.getByRole("button", { name: "Open menu" }).click();
  await page.locator("header").getByRole("link", { name: "Guide", exact: true }).filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/app\/guide$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Try a live swap.");
  // A full load: the guide is not cross-origin isolated, so it did not carry on in the node page's document.
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
});

test("the header keeps to one row at every desktop width; narrower screens get the menu", async ({ page, isMobile }) => {
  test.skip(isMobile, "Desktop widths only.");
  for (const width of [900, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    const row = page.locator("header nav > div").first();
    expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth), `${width} px`).toBe(true);
    // No link wraps onto a second line.
    const wrapped = await page
      .locator("header nav a")
      .evaluateAll((links) => links.filter((a) => getComputedStyle(a).display !== "none" && a.getBoundingClientRect().height > 40).map((a) => a.textContent));
    expect(wrapped, `${width} px`).toEqual([]);
    await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible({ visible: width < 1024 });
  }
});

test("the footer names the stage, and no longer says that nothing is paid", async ({ page }) => {
  await page.goto("/");
  const footer = page.locator("footer");
  // The public demo is live: stage 3 is "Now" (docs/roadmap.md).
  await expect(footer).toContainText("Live testnet demo: stage 3 of 6");
  await expect(footer).not.toContainText("no payments processed");
  await expect(footer.getByRole("link", { name: "Testnet guide" })).toHaveAttribute("href", "/app/guide");
});

test("the site says Live testnet demo where it said stage 2: hero, Impact strip, roadmap and FAQ", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("main").getByText("Live testnet demo by TEX Labs, stage 3 of 6")).toBeVisible();
  const impact = page.locator("#impact");
  await expect(impact).toContainText("Today, stage 3 of 6");
  await expect(impact).toContainText("Live testnet demo");
  await expect(impact.getByRole("link", { name: "Try the live demo" })).toHaveAttribute("href", "/app");
  await expect(impact.getByRole("link", { name: "Testnet guide" })).toHaveAttribute("href", "/app/guide");
  // The roadmap cards: stage 2 Done, stage 3 Now and marked as where the project is.
  const roadmap = page.locator("#roadmap");
  await expect(roadmap).toContainText("Stage 3 is where the project is today: a live testnet demo, open to testers.");
  const card = (stage: string) => roadmap.locator("div.relative").filter({ has: page.getByText(stage, { exact: true }) });
  await expect(card("Stage 2")).toContainText("Done");
  await expect(card("Stage 3")).toContainText("Now");
  await expect(card("Stage 3")).toContainText("We are here");
  await expect(card("Stage 2")).not.toContainText("We are here");
  // Stage 4 stays Planned; its Get paid and Pay deliverables carry an early-version tag, the rest stay open circles.
  await expect(roadmap).toContainText("Early versions of stage 4's Get paid and Pay run there too.");
  await expect(card("Stage 4")).toContainText("Planned");
  await expect(card("Stage 4")).not.toContainText("We are here");
  await expect(card("Stage 4").getByText(/^Live on testnet, early version: /)).toHaveText([
    "Live on testnet, early version: Get paid",
    "Live on testnet, early version: Pay",
  ]);
  await expect(card("Stage 4").getByLabel("Live on testnet", { exact: true })).toHaveCount(2);
  await expect(card("Stage 4").getByLabel("Planned", { exact: true })).toHaveCount(4);
  // The first answer is open by default: what runs on testnet, and what is not built yet.
  const works = page.locator("#faq-panel-0");
  await expect(works).toBeVisible();
  await expect(works).toContainText("A live testnet demo, with test money only.");
  await expect(works).toContainText("Pay a Lightning invoice, a Fiber invoice or a CKB address.");
  await expect(works).toContainText("Get paid from a Lightning or a Fiber wallet.");
  await expect(works).toContainText("Not built yet: the payment API, a hosted node, mainnet and a security audit.");
  await expect(works).not.toContainText(/simulat/i);
  // Nothing on the page still calls today's stage a simulation, or says stage 2 is current.
  const text = (await page.locator("body").textContent()) ?? "";
  expect(text).not.toMatch(/stage 2 of 6/i);
  expect(text).not.toContain("No payments are processed on this site");
});

test("the landing says what runs on testnet, and labels the API, the SDK, the hosted node and pooled liquidity as planned", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/rate", (route) => route.fulfill({ json: RATE }));
  await page.goto("/");
  // The Impact strip: what works today, nothing simulated, and the API as planned.
  const impact = page.locator("#impact");
  for (const chip of ["Pay Lightning and Fiber invoices", "Get paid from Lightning or Fiber", "Fiber node in your browser", "Refund when a payout fails"]) {
    await expect(impact.getByText(chip, { exact: true })).toHaveCount(1);
  }
  await expect(impact).not.toContainText(/Your own Lightning wallet|simulated/i);
  await expect(impact).toContainText("Get paid for merchants and Pay for CKB holders, all live on testnet. An API for wallets and POS terminals is planned for stage 4.");
  await expect(impact).toContainText("The hub and the quote engine run on testnet; the API is planned for stage 4.");
  // Use cases: the three uses live on testnet, pooled liquidity and the API planned.
  const features = page.locator("#features");
  await expect(features).toContainText("Live on testnet as Get paid.");
  await expect(features).toContainText("Live on testnet as Pay.");
  await expect(features).toContainText("Live on testnet for CKB and RUSD.");
  await expect(features).toContainText("Planned for stage 6: each quote compares CKBolt hubs");
  await expect(features).toContainText("Today one CKBolt hub quotes from its own liquidity, on testnet.");
  await expect(features).toContainText("Planned for stage 4: wallets, POS terminals and apps add Lightning payments and swaps with one API");
  await expect(features).toContainText("An SDK follows in stage 6.");
  // Architecture: one source of liquidity today, and the assets the testnet hub quotes.
  const architecture = page.locator("#architecture");
  await expect(architecture).toContainText("picking the cheapest of several liquidity sources is planned for stage 6");
  await expect(architecture).toContainText("Assets quoted on testnet: BTC, CKB, RUSD");
  await expect(architecture).not.toContainText(/ccBTC|picks the cheapest/);
  await expect(page.locator("#prices")).toContainText("those payments can reach CKB: on testnet today, on mainnet from stage 6.");
  // FAQ: the node runs in the browser, price risk is priced but not proven, the Cross-Chain Hub as a later source.
  const faq = page.locator("#faq");
  const answer = async (question: string) => {
    const button = page.getByRole("button", { name: question });
    await button.click();
    return page.locator(`#${await button.getAttribute("aria-controls")}`);
  };
  await expect(await answer("Does a merchant need to run a node?")).toHaveText(
    "A Fiber node, yes. On this site it runs in your browser, with nothing to install; a hosted option is planned for stage 4. Merchants never need a Lightning node or BTC.",
  );
  await expect(await answer("What if the price moves while a payment is held?")).toHaveText(
    "The hub carries that risk. Its spread includes a price-risk premium, and each swap has a size limit. Both run on the testnet hub. Neither is audited or tested with real money yet.",
  );
  await expect(await answer("How is this different from Fiber's Cross-Chain Hub?")).toContainText("Cross-Chain Hub operators as a liquidity source are planned for stage 6.");
  await expect(faq).not.toContainText(/designed, not yet tested|The simulation uses|falls back to the simulation/);
});

test("the hero's examples say they use reference prices, in amounts the testnet hub serves (1,000 to 20,000 sats a swap)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/rate", (route) => route.fulfill({ json: RATE }));
  await page.goto("/");
  const examples = page.locator('[data-marquee-copy="0"]');
  await expect(examples).toContainText("on Lightning for 1,000 CKB");
  await expect(examples).toContainText("for 10 RUSD, a stablecoin on CKB");
  const text = (await examples.textContent()) ?? "";
  const sats = [...text.matchAll(/([\d,]+) (?:sats|SATS)/g)].map((m) => Number(m[1].replace(/,/g, "")));
  expect(sats).toHaveLength(4);
  for (const n of sats) expect(n >= 1_000 && n <= 20_000, `${n} sats`).toBe(true);
  expect(text.match(/REFERENCE PRICES/g)).toHaveLength(4);
});

test("landing page renders without console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/rate", (route) => route.fulfill({ json: RATE }));
  await page.route("**/api/lightning-stats", (route) => route.fulfill({ json: LIGHTNING }));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Pay, get paid, swap.");
  await page.locator("#prices").scrollIntoViewIfNeeded();
  // Live Lightning network figures, with their source and date.
  await expect(page.locator("#prices")).toContainText("11,545,693 sats");
  await expect(page.locator("#prices")).toContainText("16,227");
  await expect(page.locator("#prices")).toContainText("3,754 BTC");
  await expect(page.locator("#prices")).toContainText("mempool.space latest published public-network statistics");
  expect(errors).toEqual([]);
});

test("nothing is wider than the screen", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/rate", (route) => route.fulfill({ json: RATE }));
  await page.goto("/");
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 700) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
  });
  await expectNoHorizontalOverflow(page);
  for (const mode of ["receive", "pay", "swap"] as const) {
    await openApp(page, mode);
    await expectNoHorizontalOverflow(page);
  }
});

test.describe("API routes", () => {
  test("rate API returns prices or a clear error", async ({ request }) => {
    const res = await request.get("/api/rate");
    const body = await res.json();
    if (res.status() === 200) {
      for (const key of ["btcUsd", "ethUsd", "ckbUsd"]) expect(body[key]).toBeGreaterThan(0);
    } else {
      expect(res.status()).toBe(503);
      expect(body.error).toBeTruthy();
    }
  });

  test("Lightning statistics API returns network figures or a clear error", async ({ request }) => {
    const res = await request.get("/api/lightning-stats");
    const body = await res.json();
    if (res.status() === 200) {
      for (const key of ["nodes", "channels", "capacitySats"]) expect(body[key]).toBeGreaterThan(0);
      expect(body.source).toBe("mempool.space");
    } else {
      expect(res.status()).toBe(503);
      expect(body.error).toBeTruthy();
    }
  });
});

test.describe("/app without a hub", () => {
  test("every tab says the hub is not available, in one line: nothing simulated, no wallet panel, no wallet connector", async ({ page }) => {
    for (const mode of MODES) {
      const panel = await openApp(page, mode);
      await expect(panel.getByTestId("hub-unavailable")).toHaveText(HUB_UNAVAILABLE);
      await expect(panel).not.toContainText(/Simulated|simulation|stage 4|Create checkout|Execute swap/i);
    }
    await expect(page.getByRole("tab")).toHaveText(["Get paid", "Pay", "Swap"]);
    for (const id of ["ckb-wallet", "btc-wallet", "swap-card", "price-source"]) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Connect (CKB|Bitcoin) wallet/ })).toHaveCount(0);
    await expect(page.locator("ccc-connector")).toHaveCount(0);
  });

  test("the tabs keep their deep links, and the address follows the visitor's choice", async ({ page }) => {
    await openApp(page, "pay");
    await expect(page.getByRole("tab", { name: "Pay" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Swap" }).click();
    await expect(page.getByTestId("mode-swap").getByTestId("hub-unavailable")).toBeVisible();
    expect(new URL(page.url()).search).toBe("?mode=swap");
  });
});

test.describe("details", () => {
  test("lets the visitor pause all motion, and remembers it", async ({ page }) => {
    await page.route("**/api/rate", (route) => route.fulfill({ json: RATE }));
    await page.goto("/");
    await page.getByRole("button", { name: "Pause motion" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-motion", "paused");
    // Stopped marquees become wrapped lists without the duplicate copies.
    await expect(page.locator("[data-marquee]").first()).toHaveCSS("animation-name", "none");
    await expect(page.locator('[data-marquee-copy="1"]').first()).toBeHidden();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-motion", "paused");
    await expect(page.getByRole("button", { name: "Play motion" })).toBeVisible();
  });

});

test.describe("accessibility", () => {
  const scan = async (page: Page) => {
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 5).join(", ")}`)).toEqual([]);
  };

  test("no serious axe violations on the landing page", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/rate", (route) => route.fulfill({ json: RATE }));
    await page.goto("/");
    // Reveal every section so scroll-in animations have finished.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 600) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
    });
    await page.waitForTimeout(1500);
    await scan(page);
  });

  for (const mode of ["receive", "pay", "swap"] as const) {
    test(`no serious axe violations in the ${mode} tab`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await openApp(page, mode);
      await scan(page);
    });
  }

});
