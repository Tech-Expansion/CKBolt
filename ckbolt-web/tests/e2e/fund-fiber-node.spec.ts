import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { TESTNET_RUSD, TYPE_ID_CODE_HASH } from "../../lib/wallets/fiber-byo/constants";
import { lockScriptToAddress } from "../../lib/wallets/fiber-byo/funding";
import { FakeHub, RATE } from "./fakes/hub";
import {
  CKB_TESTNET_RPC,
  FakeCkbChain,
  readUdtData,
  rpcTransactionHash,
  sameScript,
  secpLock,
  udtData,
  units,
  type JsonRpcRequest,
  type Script,
} from "./fiber-byo-fakes";
import { expectNoHorizontalOverflow, expectNoSeriousAxe } from "./page-checks";
import { chooseUtxoGlobal, installCkbWallet, type FakeCkbWallet } from "./support/ckb-wallet";

/*
 * "Fund my Fiber node" (components/app/fund-fiber-node.tsx) on the funding page, /app/fiber/fund?address=…: the only
 * place an L1 wallet appears for live swaps (docs/live-swap-ui.md), linked from the node page and the Fiber wallet
 * dialog. The CKB testnet RPC is a fake chain (tests/e2e/fiber-byo-fakes.ts), the CKB wallet a stand-in for the UTXO
 * Global extension whose signing the test decides, and /api/hub/** a fake hub that records what it is asked. No request
 * leaves the machine.
 */

const FUND_PAGE = "/app/fiber/fund";

/** Answers CCC's CKB testnet RPC (WebSocket first, HTTP fallbacks) from a fake chain. */
async function installChain(page: Page, chain: FakeCkbChain) {
  await page.routeWebSocket(CKB_TESTNET_RPC.WS, (ws) => {
    ws.onMessage((message) => {
      const payload = JSON.parse(String(message)) as JsonRpcRequest | JsonRpcRequest[];
      ws.send(JSON.stringify(Array.isArray(payload) ? payload.map((p) => chain.handle(p)) : chain.handle(payload)));
    });
  });
  for (const url of CKB_TESTNET_RPC.HTTP) {
    await page.route(url, (route) => {
      const payload = route.request().postDataJSON() as JsonRpcRequest | JsonRpcRequest[];
      return route.fulfill({ json: Array.isArray(payload) ? payload.map((p) => chain.handle(p)) : chain.handle(payload) });
    });
  }
}

/** The RUSD code cell on the fake chain, found by its Type ID like on CKB testnet. */
const addRusdCode = (chain: FakeCkbChain) =>
  chain.addCell({
    lock: secpLock(),
    capacity: units(100_000),
    type: { codeHash: TYPE_ID_CODE_HASH, hashType: "type", args: TESTNET_RUSD.codeTypeIdArgs },
    data: `0x${"00".repeat(64)}`,
  });

/* ------------------------------------------------------------------------------------------------ helpers */

/** A Row's label cell: the <dt> whose own text (before its note) is the label. */
const rowLabel = (scope: Locator, label: string) => scope.locator(`xpath=.//dt[normalize-space(text()[1])="${label}"]`);
const rowValue = (scope: Locator, label: string) => rowLabel(scope, label).locator("xpath=following-sibling::dd[1]");
const rowNote = (scope: Locator, label: string) => rowLabel(scope, label).locator("span");
const review = (fund: Locator) => fund.getByRole("button", { name: "Review transfer" });

/** Requests that carry a string in their URL or body; the funding page's own address bar carries the node's address. */
const carrying = (sent: Request[], text: string) =>
  sent.filter((r) => !r.isNavigationRequest() && (r.url().includes(text) || (r.postData() ?? "").includes(text))).map((r) => `${r.method()} ${r.url()}`);

interface FundPage {
  hub: FakeHub;
  chain: FakeCkbChain;
  wallet: FakeCkbWallet;
  fund: Locator;
  nodeLock: Script;
  nodeAddress: string;
  /** Every request the page made, for the privacy checks. */
  sent: Request[];
}

/** The funding page for a node address (a fresh testnet node unless given), with a fake chain, wallet and hub. */
async function openFundPage(page: Page, opts: { wallet?: { lock?: Script; address?: string }; nodeAddress?: (wallet: FakeCkbWallet) => string } = {}): Promise<FundPage> {
  const hub = new FakeHub();
  const chain = new FakeCkbChain();
  const sent: Request[] = [];
  page.on("request", (r) => sent.push(r));
  const wallet = await installCkbWallet(page, opts.wallet);
  await page.route("**/api/rate", (route) => route.fulfill({ json: RATE }));
  await hub.install(page);
  await installChain(page, chain);
  const nodeLock = secpLock();
  const nodeAddress = opts.nodeAddress?.(wallet) ?? lockScriptToAddress(nodeLock);
  await page.goto(`${FUND_PAGE}?address=${nodeAddress}`);
  const fund = page.getByTestId("fund-fiber-node");
  // The wallet connector bundle loads client-side; allow for a cold server.
  await expect(fund).toBeVisible({ timeout: 20_000 });
  return { hub, chain, wallet, fund, nodeLock, nodeAddress, sent };
}

/** Connects the fake UTXO Global wallet through CCC's connector, from the form's own Connect button. */
async function connectWallet(page: Page, fund: Locator) {
  await fund.getByRole("button", { name: "Connect CKB wallet" }).click();
  await chooseUtxoGlobal(page);
  await expect(fund.getByRole("button", { name: "Connect CKB wallet" })).toHaveCount(0, { timeout: 15_000 });
}

/** A connected wallet with these CKB cells (default 10,000 CKB) and RUSD cells on the fake chain, and the form ready. */
async function openFundForm(page: Page, opts: { rusd?: number[]; ckb?: number[] } = {}): Promise<FundPage> {
  const ctx = await openFundPage(page);
  const ckbCells = opts.ckb ?? [5_000, 5_000];
  for (const ckb of ckbCells) ctx.chain.addCell({ lock: ctx.wallet.lock, capacity: units(ckb) });
  for (const rusd of opts.rusd ?? []) ctx.chain.addCell({ lock: ctx.wallet.lock, capacity: units(142), type: TESTNET_RUSD.script, data: udtData(units(rusd)) });
  if (opts.rusd) addRusdCode(ctx.chain);
  await connectWallet(page, ctx.fund);
  const total = ckbCells.reduce((a, b) => a + b, 0);
  // "From UTXO Global Wallet, which holds …", or "Your wallet holds …" when the chosen amount is more than that.
  await expect(ctx.fund).toContainText(`holds ${total.toLocaleString("en-US")} CKB.`, { timeout: 15_000 });
  return ctx;
}

/** A wallet that stayed on CKB mainnet: the extension reports a ckb1 account although CCC asked it for testnet. */
async function openWithMainnetAccount(page: Page): Promise<FundPage> {
  const lock = secpLock();
  const ctx = await openFundPage(page, { wallet: { lock, address: lockScriptToAddress(lock, "ckb") } });
  ctx.chain.addCell({ lock, capacity: units(10_000) });
  await connectWallet(page, ctx.fund);
  return ctx;
}

/* ------------------------------------------------------------------------------------ fund my Fiber node */

test.describe("fund my Fiber node: the funding page", () => {
  // Each test connects a wallet through CCC's connector first, which is slow while the whole suite runs in parallel.
  test.slow();

  test("offers the hub's channel first (1,300 CKB), then the research's presets, from the connected wallet's balance, to the node in the link", async ({ page }) => {
    const { fund, nodeAddress } = await openFundForm(page);
    await expect(rowValue(fund, "To your node")).toHaveText(`${nodeAddress.slice(0, 12)}…${nodeAddress.slice(-12)}`);
    const presets = fund.getByRole("radiogroup", { name: "Amount" });
    await expect(presets.getByRole("radio")).toHaveText([
      /^1,300 CKBChannel with the CKBolt hub/,
      /^600 CKBOpen a channel to a public node/,
      /^200 CKBAccept a CKB channel/,
      /^250 CKBReserve for a token channel/,
      "Another amount",
    ]);
    // The hub's channel comes first: the node's 1,200 CKB share (as chosen on the node page) plus change and fees.
    const hubChannel = presets.getByRole("radio", { name: "1,300 CKB: Channel with the CKBolt hub" });
    await expect(hubChannel).toHaveAttribute("aria-checked", "true");
    await expect(hubChannel).toHaveAccessibleDescription(/Your node puts 1,200 CKB into the hub's channel/);
    await expect(presets.getByRole("radio", { name: "600 CKB: Open a channel to a public node" })).toHaveAccessibleDescription(/499 CKB funds a channel to bottle or bracer/);
    // No RUSD in the wallet: only CKB is offered.
    await expect(fund.getByRole("radiogroup", { name: "Token to send" })).toHaveCount(0);
    await expect(review(fund)).toBeEnabled();
  });

  test("a link to the wallet's own address funds nothing and says why", async ({ page }) => {
    const { fund, wallet } = await openFundPage(page, { nodeAddress: (w) => w.address });
    await connectWallet(page, fund);
    await expect(fund.getByText("This is your wallet's own address. Paste the address of your Fiber node.")).toBeVisible({ timeout: 15_000 });
    await expect(review(fund)).toBeDisabled();
    expect(wallet.signRequests).toEqual([]);
  });

  test("sends 600 CKB after a confirmation step: exactly 600 CKB to the node, then the hash and an explorer link", async ({ page, context, browserName }) => {
    const { fund, wallet, chain, hub, nodeLock, nodeAddress, sent } = await openFundForm(page);
    await fund.getByRole("radio", { name: "600 CKB: Open a channel to a public node" }).click();
    await review(fund).click();

    // Nothing is signed or sent until the visitor confirms.
    const confirm = fund.getByTestId("fund-confirm");
    await expect(confirm).toContainText("Check, then send from your wallet");
    await expect(rowValue(confirm, "To")).toHaveText(nodeAddress);
    await expect(rowValue(confirm, "Amount")).toHaveText("600 CKB");
    await expect(rowValue(confirm, "Network")).toHaveText("CKB testnet");
    await expect(rowNote(confirm, "From")).toHaveText("UTXO Global Wallet");
    await expect(confirm).toContainText("Once sent, a transfer cannot be undone.");
    expect(wallet.signRequests).toEqual([]);
    expect(chain.sent).toEqual([]);

    await confirm.getByRole("button", { name: "Send 600 CKB" }).click();
    const done = fund.getByTestId("fund-sent");
    await expect(done.getByRole("status")).toHaveText("Sent 600 CKB to your node. It can use it once the transaction confirms on CKB testnet.");
    expect(wallet.signRequests).toHaveLength(1);
    expect(chain.sent).toHaveLength(1);
    const tx = chain.sent[0];
    expect(sameScript(tx.outputs[0].lock, nodeLock)).toBe(true);
    expect(BigInt(tx.outputs[0].capacity)).toBe(units(600));
    expect(tx.outputs.filter((o) => sameScript(o.lock, nodeLock))).toHaveLength(1);
    expect(tx.outputs.slice(1).every((o) => sameScript(o.lock, wallet.lock))).toBe(true);
    // The wallet signed the same transaction that went out.
    expect(BigInt(wallet.signRequests[0].outputs[0].capacity)).toBe(units(600));

    const hash = rpcTransactionHash(tx);
    await expect(rowValue(done, "Transaction")).toHaveText(`${hash.slice(0, 10)}…${hash.slice(-10)}`);
    const explorer = done.getByRole("link", { name: "View on CKB Explorer (testnet)" });
    await expect(explorer).toHaveAttribute("href", `https://testnet.explorer.nervos.org/transaction/${hash}`);
    await expect(explorer).toHaveAttribute("target", "_blank");
    if (browserName === "chromium") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await done.getByRole("button", { name: "Copy transaction hash" }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(hash);
    }
    // Funding is between the wallet and CKB testnet: the hub never hears of it, and no web request carries either address.
    expect(hub.requests.filter((r) => !r.startsWith("GET "))).toEqual([]);
    expect(carrying(sent, nodeAddress)).toEqual([]);
    expect(carrying(sent, wallet.address)).toEqual([]);

    await done.getByRole("button", { name: "Send more" }).click();
    await expect(review(fund)).toBeVisible();
  });

  test("a refusal in the wallet sends nothing and says so; Back returns to the form with what was picked", async ({ page }) => {
    const { fund, wallet, chain } = await openFundForm(page);
    wallet.decision = "reject";
    await fund.getByRole("radio", { name: "200 CKB: Accept a CKB channel" }).click();
    await review(fund).click();
    const confirm = fund.getByTestId("fund-confirm");
    await confirm.getByRole("button", { name: "Send 200 CKB" }).click();
    await expect(fund.getByTestId("fund-error")).toHaveText("You cancelled in your wallet, so nothing was sent.");
    await expect(fund.getByRole("alert")).toBeVisible();
    expect(wallet.signRequests).toHaveLength(1);
    expect(chain.sent).toEqual([]);
    await expect(confirm.getByRole("button", { name: "Send 200 CKB" })).toBeEnabled();
    await confirm.getByRole("button", { name: "Back" }).click();
    await expect(fund.getByTestId("fund-error")).toHaveCount(0);
    await expect(fund.getByRole("radio", { name: "200 CKB: Accept a CKB channel" })).toHaveAttribute("aria-checked", "true");
  });

  test("another amount: at least one CKB cell, no more than the wallet holds, sent exactly", async ({ page }) => {
    const { fund, chain, nodeLock } = await openFundForm(page);
    await fund.getByRole("radio", { name: "Another amount" }).click();
    const amount = fund.getByLabel("Amount in CKB");
    await expect(review(fund)).toBeDisabled();
    await amount.fill("60");
    await expect(fund.getByText("Send at least 61 CKB: a CKB cell cannot hold less.")).toBeVisible();
    await expect(amount).toHaveAttribute("aria-invalid", "true");
    await expect(review(fund)).toBeDisabled();
    await amount.fill("10000.5");
    await expect(fund.getByText("Your wallet holds 10,000 CKB. Send less, or top the wallet up first.")).toBeVisible();
    await expect(review(fund)).toBeDisabled();
    await amount.fill("0");
    await expect(fund.getByText("Enter an amount to send.")).toBeVisible();
    await amount.fill("70.12345678");
    await expect(amount).toHaveAttribute("aria-invalid", "false");
    await review(fund).click();
    await expect(rowValue(fund.getByTestId("fund-confirm"), "Amount")).toHaveText("70.12345678 CKB");
    await fund.getByRole("button", { name: "Send 70.12345678 CKB" }).click();
    await expect(fund.getByTestId("fund-sent")).toBeVisible();
    expect(BigInt(chain.sent[0].outputs[0].capacity)).toBe(BigInt("7012345678"));
    expect(sameScript(chain.sent[0].outputs[0].lock, nodeLock)).toBe(true);
  });

  test("a wallet without enough CKB for the amount and fee gets a plain sentence and nothing is sent", async ({ page }) => {
    // 600 of 600 CKB: the balance check passes, but nothing is left for the fee.
    const { fund, wallet, chain } = await openFundForm(page, { ckb: [600] });
    await fund.getByRole("radio", { name: "600 CKB: Open a channel to a public node" }).click();
    await review(fund).click();
    await fund.getByRole("button", { name: "Send 600 CKB" }).click();
    await expect(fund.getByTestId("fund-error")).toHaveText("Your wallet does not hold enough CKB for this amount and the fee.");
    expect(wallet.signRequests).toEqual([]);
    expect(chain.sent).toEqual([]);
  });

  test("RUSD is offered once the wallet holds some, and 20 RUSD go to the node exactly", async ({ page }) => {
    const { fund, wallet, chain, nodeLock } = await openFundForm(page, { rusd: [15, 30] });
    const tokens = fund.getByRole("radiogroup", { name: "Token to send" });
    await expect(tokens.getByRole("radio")).toHaveText(["CKB", "RUSD"]);
    await tokens.getByRole("radio", { name: "RUSD" }).click();
    const presets = fund.getByRole("radiogroup", { name: "Amount" });
    await expect(presets.getByRole("radio")).toHaveText([/^20 RUSDOpen an RUSD channel to a public node/, "Another amount"]);
    await expect(fund).toContainText("From UTXO Global Wallet, which holds 45 RUSD. The RUSD cell also brings some CKB to the node.");
    await review(fund).click();
    await expect(rowValue(fund.getByTestId("fund-confirm"), "Amount")).toHaveText("20 RUSD");
    await fund.getByRole("button", { name: "Send 20 RUSD" }).click();
    await expect(fund.getByTestId("fund-sent").getByRole("status")).toHaveText("Sent 20 RUSD to your node. It can use it once the transaction confirms on CKB testnet.");
    expect(chain.sent).toHaveLength(1);
    const tx = chain.sent[0];
    expect(sameScript(tx.outputs[0].lock, nodeLock)).toBe(true);
    expect(sameScript(tx.outputs[0].type ?? null, TESTNET_RUSD.script)).toBe(true);
    expect(readUdtData(tx.outputs_data[0])).toBe(units(20));
    const change = tx.outputs.findIndex((o, i) => i > 0 && sameScript(o.type ?? null, TESTNET_RUSD.script));
    expect(sameScript(tx.outputs[change].lock, wallet.lock)).toBe(true);
    expect(readUdtData(tx.outputs_data[change])).toBe(units(25));
    // Back to CKB: the RUSD amount does not carry over.
    await fund.getByRole("button", { name: "Send more" }).click();
    await tokens.getByRole("radio", { name: "CKB" }).click();
    await expect(fund.getByRole("radio", { name: "1,300 CKB: Channel with the CKBolt hub" })).toHaveAttribute("aria-checked", "true");
  });

  test("switching account in the wallet drops a transfer waiting for confirmation", async ({ page }) => {
    const { fund, wallet, chain } = await openFundForm(page);
    await review(fund).click();
    await expect(fund.getByTestId("fund-confirm")).toBeVisible();
    await page.evaluate(() => (window as unknown as { __fbyoWalletEmit: (e: string) => void }).__fbyoWalletEmit("accountsChanged"));
    await expect(fund.getByTestId("fund-confirm")).toHaveCount(0);
    await expect(fund.getByRole("button", { name: /^Send / })).toHaveCount(0);
    expect(wallet.signRequests).toEqual([]);
    expect(chain.sent).toEqual([]);
  });

  test("a wallet whose account is on CKB mainnet is refused up front, and cannot sign or send anything", async ({ page }) => {
    const { fund, wallet, chain } = await openWithMainnetAccount(page);
    await expect(fund.getByTestId("fund-wrong-network")).toHaveText("Your CKB wallet is on CKB mainnet. Switch it to CKB testnet: CKBolt only sends test CKB.", {
      timeout: 15_000,
    });
    await expect(review(fund)).toHaveCount(0);
    await expect(fund.getByRole("button", { name: /^Send / })).toHaveCount(0);
    expect(wallet.signRequests).toEqual([]);
    expect(chain.sent).toEqual([]);
  });

  test("with a wallet connected: nothing wider than the screen, no serious axe violations", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const { fund } = await openFundForm(page);
    await fund.getByRole("radio", { name: "Another amount" }).click();
    await fund.getByLabel("Amount in CKB").fill("60");
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousAxe(page, "[data-testid=fund-node-page]");
  });
});
