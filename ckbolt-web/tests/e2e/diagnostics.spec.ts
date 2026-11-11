import { test, expect, type Page } from "@playwright/test";
import { demoFiberInvoice } from "../../lib/payment-request";
import { expectNoHorizontalOverflow, expectNoSeriousAxe } from "./page-checks";
import { createRunningNode, HUB_FIBER_NODE, hubChannel, installFakeNode, nodeCalls, nodeDryRuns, nodePayments, nodeSends, RUSD_SCRIPT, units } from "./support/fiber-node";
import { isolate, LiveHub } from "./support/live-hub";

/*
 * The node page's Diagnostics panel (/app/fiber, panel 06): Copy diagnostics puts node_info and list_channels in a JSON
 * a Fiber developer can read (lib/wallets/fiber-browser/diagnostics.ts), and Check a route runs send_payment dry runs of
 * a pasted invoice, directly and through the hub. The node is the fake fiber-js of support/fiber-node.ts; nothing
 * reaches a real network.
 */

const TEST_TIMEOUT_MS = 90_000;
const PHONE = { width: 390, height: 844 };
const NODE_PASSWORD = "testnet node pass";
const HUB_ID = HUB_FIBER_NODE.nodeId;
const NO_PATH = "Send payment error: Failed to build route, PathFind error: no path found";
/** 10 CKB: the Pay tab's fee cap is 0.5 %, 0.05 CKB. */
const AMOUNT = units(10);
const MAX_FEE = AMOUNT / BigInt(200);
const TRAMPOLINE_FEE = BigInt(2_000_000);

const panel = (page: Page) => page.getByTestId("fiber-node-diagnostics");

async function runningNode(page: Page) {
  await isolate(page.context());
  await new LiveHub().install(page.context());
  await installFakeNode(page.context(), {
    channels: [hubChannel({ local: units(1_000), remote: units(500) }), hubChannel({ local: units(30), remote: units(20), udt: RUSD_SCRIPT })],
    // Direct: no route (the payee sits behind a private channel); through the hub: found, with this fee.
    routes: { direct: NO_PATH, trampoline: null },
    sendPayment: { status: "Inflight", failedError: null, throws: null, fee: `0x${TRAMPOLINE_FEE.toString(16)}` },
  });
  await page.goto("/app/fiber");
  await expect(page.getByTestId("fiber-node-key")).toBeVisible();
  // Locked or not set up: no diagnostics yet.
  await expect(panel(page)).toHaveCount(0);
  await createRunningNode(page);
  await expect(panel(page)).toBeVisible();
}

const readClipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test.describe("Diagnostics on the node page", () => {
  test.setTimeout(TEST_TIMEOUT_MS);

  test("Copy diagnostics copies the node's version and channels as JSON, nothing secret", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await runningNode(page);
    await panel(page).getByRole("button", { name: "Copy diagnostics" }).click();
    await expect(panel(page).getByTestId("diagnostics-copy-status")).toContainText("Copied");
    const text = await readClipboard(page);
    await expect(panel(page).getByRole("region", { name: "Diagnostics JSON" })).toHaveText(text);
    const d = JSON.parse(text);
    expect(d).toMatchObject({
      kind: "ckbolt-fiber-diagnostics",
      network: "testnet",
      app: { fiberJsVersion: "0.9.1" },
      hubNodeId: HUB_ID,
      nodeInfo: { version: "0.9.1", tlc: { feeProportionalMillionths: "1000" }, autoAccept: { autoAcceptChannelCkbFundingAmount: "0" } },
      channels: { includesClosed: true, count: 2 },
      routeCheck: null,
    });
    expect(d.nodeInfo.nodeId).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(Date.parse(d.generatedAt)).toBeGreaterThan(0);
    expect(d.channels.list.map((c: { asset: { kind: string; name?: string }; localBalance: string; remoteBalance: string; withHub: boolean; isPublic: boolean }) => [c.asset.name ?? c.asset.kind, c.localBalance, c.remoteBalance, c.withHub, c.isPublic])).toEqual([
      ["CKB", units(1_000).toString(), units(500).toString(), true, false],
      ["RUSD", units(30).toString(), units(20).toString(), true, false],
    ]);
    expect(text).not.toMatch(/secret|private|preimage|password|mnemonic/i);
    expect(text).not.toContain(NODE_PASSWORD);
    // Closed channels too: list_channels was asked for them.
    expect(await nodeCalls(page, "list_channels")).toContainEqual({ include_closed: true });
  });

  test("Check a route runs dry runs only, shows each outcome, and puts them in the next copy", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await runningNode(page);
    const invoice = demoFiberInvoice("testnet", AMOUNT);
    const field = panel(page).getByLabel("Check a route");
    const submit = panel(page).getByRole("button", { name: "Check route" });
    await expect(submit).toBeDisabled();

    // A Lightning invoice is refused before the node is asked.
    await field.fill("lntbs10u1qqqqqq");
    await submit.click();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(panel(page)).toContainText("This is a Lightning invoice.");
    expect(await nodeCalls(page, "send_payment")).toEqual([]);

    await field.fill(invoice);
    await submit.click();
    const checks = panel(page).getByTestId("diagnostics-route-check");
    await expect(checks).toHaveCount(2);
    await expect(checks.nth(0)).toHaveAttribute("data-via", "direct");
    await expect(checks.nth(0)).toHaveAttribute("data-ok", "false");
    await expect(checks.nth(0)).toContainText(`Direct: No route: ${NO_PATH}`);
    await expect(checks.nth(1)).toHaveAttribute("data-ok", "true");
    await expect(checks.nth(1)).toContainText("Through the hub (trampoline): Route found, fee 0.02 CKB");
    await expect(panel(page).getByTestId("diagnostics-route-skipped")).toHaveCount(0);

    // Dry runs, with the Pay tab's fee cap, the second through the hub; no payment session, nothing in History.
    expect(await nodeSends(page)).toEqual([]);
    expect(await nodeDryRuns(page)).toEqual([
      { invoice, max_fee_amount: `0x${MAX_FEE.toString(16)}`, dry_run: true },
      { invoice, max_fee_amount: `0x${MAX_FEE.toString(16)}`, trampoline_hops: [HUB_ID], dry_run: true },
    ]);
    expect(await nodePayments(page)).toEqual({});
    await expect(page.getByTestId("history-entry")).toHaveCount(0);

    await panel(page).getByRole("button", { name: "Copy diagnostics" }).click();
    await expect(panel(page).getByTestId("diagnostics-copy-status")).toContainText("Copied");
    const text = await readClipboard(page);
    expect(text).not.toContain(invoice);
    const route = JSON.parse(text).routeCheck;
    expect(route).toMatchObject({ dryRun: true, target: { network: "testnet", amount: AMOUNT.toString() }, trampolineSkipped: null });
    expect(route.checks.map((c: { via: string; ok: boolean; fee: string | null; error: string | null }) => [c.via, c.ok, c.fee, c.error])).toEqual([
      ["direct", false, null, NO_PATH],
      ["trampoline", true, TRAMPOLINE_FEE.toString(), null],
    ]);
  });

  test("a hub id kept from before is never probed: without the hub's live node only the direct dry run runs, and it says so", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await isolate(context);
    await new LiveHub().install(context);
    // The hub cannot be reached now, but this browser kept its node id from an earlier visit.
    await context.route("**/api/hub/v1/fiber/node", (route) =>
      route.fulfill({ status: 503, json: { error: { code: "hub_unavailable", message: "The hub is not reachable right now." } } }),
    );
    await context.addInitScript((id) => localStorage.setItem("ckbolt:fiber-browser:testnet:hub-node-id", id), HUB_ID);
    await installFakeNode(context, { channels: [hubChannel({ local: units(1_000), remote: units(500) })], routes: { direct: NO_PATH, trampoline: null } });
    await page.goto("/app/fiber");
    await page.getByLabel("Password, at least 8 characters").fill(NODE_PASSWORD);
    await page.getByLabel("Repeat the password").fill(NODE_PASSWORD);
    await page.getByRole("button", { name: "Create node" }).click();
    await expect(panel(page)).toBeVisible({ timeout: 30_000 });

    const invoice = demoFiberInvoice("testnet", AMOUNT);
    await panel(page).getByLabel("Check a route").fill(invoice);
    await panel(page).getByRole("button", { name: "Check route" }).click();
    await expect(panel(page).getByTestId("diagnostics-route-check")).toHaveCount(1);
    await expect(panel(page).getByTestId("diagnostics-route-check")).toHaveAttribute("data-via", "direct");
    const skipped = panel(page).getByTestId("diagnostics-route-skipped");
    await expect(skipped).toHaveText("Through the hub (trampoline): Not checked: the hub's Fiber node is not available now.");
    await expect(skipped).toHaveAttribute("data-reason", "no_hub_node");
    expect(await nodeDryRuns(page)).toEqual([{ invoice, max_fee_amount: `0x${MAX_FEE.toString(16)}`, dry_run: true }]);

    await panel(page).getByRole("button", { name: "Copy diagnostics" }).click();
    await expect(panel(page).getByTestId("diagnostics-copy-status")).toContainText("Copied");
    const d = JSON.parse(await readClipboard(page));
    expect(d.hubNodeId).toBeNull();
    expect(d.routeCheck.trampolineSkipped).toBe("no_hub_node");
    expect(d.routeCheck.checks.map((c: { via: string }) => c.via)).toEqual(["direct"]);
    // The kept id still names the hub's channel.
    expect(d.channels.list.map((c: { withHub: boolean }) => c.withHub)).toEqual([true]);
  });

  test("no serious axe finding, and nothing overflows at 390 px", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize(PHONE);
    await runningNode(page);
    await panel(page).getByRole("button", { name: "Copy diagnostics" }).click();
    await expect(panel(page).getByTestId("diagnostics-json")).toBeVisible();
    await panel(page).getByLabel("Check a route").fill(demoFiberInvoice("testnet", AMOUNT));
    await panel(page).getByRole("button", { name: "Check route" }).click();
    await expect(panel(page).getByTestId("diagnostics-route-check")).toHaveCount(2);
    await expectNoSeriousAxe(page, '[data-testid="fiber-node-diagnostics"]');
    await expectNoHorizontalOverflow(page);
  });
});
