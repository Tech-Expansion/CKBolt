import { expect, test } from "@playwright/test";
import { ManualFiberStep, type FiberInvoiceRequest, type FiberWalletState } from "../../components/app/swap/contracts";
import { fiberChipView } from "../../components/app/swap/wallets/chip-view";
import { WALLET_TONE_LABEL } from "../../components/app/swap/wallets/copy";
import { WALLET_TONE_STATUS } from "../../components/app/swap/wallets/status-dot";
import { hubLightningNetworkName } from "../../components/app/swap/wallets/copy";
import type { AssetDto } from "../../lib/hub/contract";
import { demoFiberInvoice } from "../../lib/payment-request";
import { BridgeError } from "../../lib/wallets/fiber-browser/bridge-client";
import { BRIDGE_ERROR, type MakeInvoiceParams, type NodePresence, type PayInvoiceParams } from "../../lib/wallets/fiber-browser/bridge-protocol";
import type { KeyValueStore } from "../../lib/wallets/fiber-browser/storage";
import { BrowserNodeWallet, type BrowserNodePort } from "../../lib/wallets/fiber-wallet/browser-node-wallet";
import { FIBER_WALLET_KIND_STORAGE_KEY } from "../../lib/wallets/fiber-wallet/constants";
import { checkNodeInvoice } from "../../lib/wallets/fiber-wallet/invoice-check";
import { hasChannel, liquidityRows, MAX_LIQUIDITY_ASSETS, readLiquidity } from "../../lib/wallets/fiber-wallet/liquidity";
import { FIBER_WALLET_MESSAGE, FIBER_WALLET_PROBLEM } from "../../lib/wallets/fiber-wallet/messages";
import { nodeFixPage, readNodeFunds, shortOfChannelFunds } from "../../lib/wallets/fiber-wallet/node-page";
import { isPassingProblem, NODE_STATUS_LABEL, nodeRuns, nodeStatusLines } from "../../lib/wallets/fiber-wallet/node-status";
import { fiberActionRoute, fiberWalletState, FIBER_WALLET_NONE, type BrowserNodeView } from "../../lib/wallets/fiber-wallet/state";
import { readFiberWalletKind, saveFiberWalletKind } from "../../lib/wallets/fiber-wallet/storage";

/*
 * The Fiber wallet of the live swap card (docs/live-swap-ui.md, part "wallets"): the provider's state machine over the
 * node tab's answers, the browser node driven through a fake bridge, the checks on what it returns, the remembered
 * choice, and what the Fiber node's chip shows.
 */

const CKB = (whole: number) => (BigInt(whole) * BigInt(100_000_000)).toString();

const presence = (patch: Partial<NodePresence> = {}): NodePresence => ({
  phase: "running",
  nodeId: "02ab",
  network: "testnet",
  hubConnected: true,
  liquidity: { CKB: { send: CKB(100), receive: CKB(2_000) } },
  ...patch,
});

const view = (p: NodePresence | null, checking = false): BrowserNodeView => ({ presence: p, checking });

const request = (patch: Partial<FiberInvoiceRequest> = {}): FiberInvoiceRequest => ({
  asset: "CKB",
  amount: CKB(1_000),
  quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  network: "testnet",
  ...patch,
});

/* ------------------------------------------------------------------------------------------ state machine */

test.describe("Fiber wallet state", () => {
  test("nothing chosen is not ready and has no problem: the card asks to connect", () => {
    expect(fiberWalletState(null, view(presence()), "testnet")).toEqual(FIBER_WALLET_NONE);
  });

  test("the own node is always ready, with unknown liquidity", () => {
    const state = fiberWalletState("own-node", view(null), "testnet");
    expect(state).toEqual({ kind: "own-node", label: "External node", ready: true, liquidity: null, problem: null, funds: null });
  });

  test("a running browser node connected to the hub with a channel is ready", () => {
    const state = fiberWalletState("browser-node", view(presence()), "testnet");
    expect(state.ready).toBe(true);
    expect(state.problem).toBeNull();
    expect(state.label).toBe("CKBolt node");
    expect(state.liquidity).toEqual({ CKB: { send: CKB(100), receive: CKB(2_000) } });
  });

  const cases: [string, BrowserNodeView, string | null, string][] = [
    ["no answer yet", view(null, true), "testnet", FIBER_WALLET_PROBLEM.LOOKING],
    ["no tab", view(null), "testnet", FIBER_WALLET_PROBLEM.NOT_OPEN],
    ["locked", view(presence({ phase: "locked" })), "testnet", FIBER_WALLET_PROBLEM.LOCKED],
    ["starting", view(presence({ phase: "starting" })), "testnet", FIBER_WALLET_PROBLEM.STARTING],
    ["other tab", view(presence({ phase: "other-tab" })), "testnet", FIBER_WALLET_PROBLEM.OTHER_TAB],
    ["failed", view(presence({ phase: "failed" })), "testnet", FIBER_WALLET_PROBLEM.FAILED],
    ["hub on devnet", view(presence()), "devnet", FIBER_WALLET_PROBLEM.WRONG_NETWORK("devnet")],
    ["not connected to the hub", view(presence({ hubConnected: false })), "testnet", FIBER_WALLET_PROBLEM.HUB_NOT_CONNECTED],
    ["no channel", view(presence({ liquidity: { CKB: { send: "0", receive: "0" } } })), "testnet", FIBER_WALLET_PROBLEM.NO_CHANNEL],
    ["no liquidity reported", view(presence({ liquidity: {} })), "testnet", FIBER_WALLET_PROBLEM.NO_CHANNEL],
  ];
  for (const [name, v, hub, problem] of cases) {
    test(`browser node, ${name}: not ready, "${problem}"`, () => {
      const state = fiberWalletState("browser-node", v, hub);
      expect(state.ready).toBe(false);
      expect(state.problem).toBe(problem);
    });
  }

  test("problems are short enough for the primary button", () => {
    const problems = [...cases.map(([, v, hub]) => fiberWalletState("browser-node", v, hub).problem!)];
    for (const problem of problems) expect(problem.split(/\s+/).length).toBeLessThanOrEqual(12);
  });

  test("an unknown hub network does not block the node", () => {
    expect(fiberWalletState("browser-node", view(presence()), null).ready).toBe(true);
  });

  test("an RUSD channel alone counts as a channel", () => {
    const state = fiberWalletState("browser-node", view(presence({ liquidity: { CKB: { send: "0", receive: "0" }, RUSD: { send: "0", receive: "20" } } })), "testnet");
    expect(state.ready).toBe(true);
  });

  test("actions go to the ready browser node, to the own node by hand, or nowhere with the reason", () => {
    expect(fiberActionRoute(fiberWalletState("browser-node", view(presence()), "testnet"))).toEqual({ to: "browser-node" });
    expect(fiberActionRoute(fiberWalletState("own-node", view(null), "testnet"))).toEqual({ to: "own-node" });
    expect(fiberActionRoute(fiberWalletState("browser-node", view(presence({ phase: "locked" })), "testnet"))).toEqual({
      to: "nowhere",
      reason: FIBER_WALLET_PROBLEM.LOCKED,
    });
    expect(fiberActionRoute(FIBER_WALLET_NONE)).toEqual({ to: "nowhere", reason: FIBER_WALLET_MESSAGE.NOT_CHOSEN });
  });

  test("the dialog's status lines follow the tab", () => {
    expect(nodeStatusLines(view(null, true))).toEqual({ node: NODE_STATUS_LABEL.CHECKING, hub: null });
    expect(nodeStatusLines(view(null))).toEqual({ node: NODE_STATUS_LABEL.NOT_OPEN, hub: null });
    expect(nodeStatusLines(view(presence({ phase: "locked" })))).toEqual({ node: "Locked", hub: null });
    expect(nodeStatusLines(view(presence()))).toEqual({ node: "Running", hub: "Connected" });
    expect(nodeStatusLines(view(presence({ hubConnected: false })))).toEqual({ node: "Running", hub: "Not connected" });
    expect(nodeRuns(view(presence()))).toBe(true);
    expect(nodeRuns(view(presence({ phase: "starting" })))).toBe(false);
    expect(isPassingProblem(FIBER_WALLET_PROBLEM.STARTING)).toBe(true);
    expect(isPassingProblem(FIBER_WALLET_PROBLEM.LOCKED)).toBe(false);
    expect(isPassingProblem(null)).toBe(false);
  });
});

/* ------------------------------------------------------------------------------- the swap card's CTAs */

test.describe("where the swap card sends the visitor to fix their browser node", () => {
  const SHANNONS = BigInt(100_000_000);
  // What the node puts in (49,000 CKB here) plus the fee margin must be on chain before it accepts the hub's CKB channel.
  const rich = { onChainCkb: BigInt(60_000) * SHANNONS, contributionCkb: 49_000 };
  const poor = { onChainCkb: BigInt(100) * SHANNONS, contributionCkb: 49_000 };
  const page = (problem: string | null, shortfall: "send" | "receive" | "no-channel" | null = null, funds: typeof rich | null = rich, asset: "CKB" | "RUSD" = "CKB") =>
    nodeFixPage({ problem, shortfall, funds, asset });

  test("Open Fiber node, unlock it, wait for it, see why it failed, connect it to the hub: Home", () => {
    for (const problem of [
      FIBER_WALLET_PROBLEM.NOT_OPEN,
      FIBER_WALLET_PROBLEM.LOCKED,
      FIBER_WALLET_PROBLEM.LOOKING,
      FIBER_WALLET_PROBLEM.STARTING,
      FIBER_WALLET_PROBLEM.FAILED,
      FIBER_WALLET_PROBLEM.HUB_NOT_CONNECTED,
    ]) {
      expect(page(problem), problem).toBe("home");
    }
  });

  test("Ask the hub for a channel, can't receive, not enough to send: Channels, or Add funds while the node holds too little CKB", () => {
    expect(page(FIBER_WALLET_PROBLEM.NO_CHANNEL)).toBe("channels");
    expect(page(null, "receive")).toBe("channels");
    expect(page(null, "send")).toBe("channels");
    expect(page(null, "no-channel")).toBe("channels");
    expect(page(FIBER_WALLET_PROBLEM.NO_CHANNEL, null, poor)).toBe("add-funds");
    expect(page(null, "receive", poor)).toBe("add-funds");
    // A RUSD channel needs only its CKB reserve on chain.
    expect(page(null, "no-channel", { onChainCkb: BigInt(200) * SHANNONS, contributionCkb: 49_000 }, "RUSD")).toBe("channels");
    // Until the node says what it holds, Channels says what is missing.
    expect(page(null, "receive", null)).toBe("channels");
  });

  test("nothing to open for a node in another tab, a hub on another network, or a ready node", () => {
    expect(page(FIBER_WALLET_PROBLEM.OTHER_TAB)).toBeNull();
    expect(page(FIBER_WALLET_PROBLEM.WRONG_NETWORK("devnet"))).toBeNull();
    expect(page(null)).toBeNull();
  });

  test("the node's funds come from its tab's answer only as whole numbers", () => {
    expect(readNodeFunds({ onChainCkb: "6000000000000", contributionCkb: 49_000 })).toEqual({ onChainCkb: BigInt(6_000_000_000_000), contributionCkb: 49_000 });
    expect(readNodeFunds({ onChainCkb: null, contributionCkb: 49_000 })).toBeNull();
    expect(readNodeFunds({ onChainCkb: "1.5", contributionCkb: 49_000 })).toBeNull();
    expect(readNodeFunds({ onChainCkb: "100", contributionCkb: null })).toBeNull();
    expect(readNodeFunds({ onChainCkb: "100", contributionCkb: 1.5 })).toBeNull();
    expect(readNodeFunds({})).toBeNull();
    expect(readNodeFunds(null)).toBeNull();
    expect(shortOfChannelFunds(poor, "CKB")).toBe(true);
    expect(shortOfChannelFunds(rich, "CKB")).toBe(false);
    expect(shortOfChannelFunds(null, "CKB")).toBe(false);
  });
});

/* --------------------------------------------------------------------------------------------- liquidity */

test.describe("Fiber wallet liquidity", () => {
  test("keeps only whole base units under well-formed asset ids, whichever the hub serves", () => {
    const raw = {
      CKB: { send: "100", receive: "200" },
      RUSD: { send: "-1", receive: "5" },
      CWBTC: { send: "1.5", receive: "2" },
      // A token the hub may add by config: kept; the card shows only the assets GET /v1/assets lists.
      DOGE: { send: "1", receive: "1" },
      doge: { send: "1", receive: "1" },
      "C-KB": { send: "1", receive: "1" },
      XUDT: { send: 1, receive: "1" },
      NULL: null,
    } as unknown as NodePresence["liquidity"];
    expect(readLiquidity(raw)).toEqual({ CKB: { send: "100", receive: "200" }, DOGE: { send: "1", receive: "1" } });
    expect(readLiquidity({ CWBTC: { send: "150000000", receive: "0" } })).toEqual({ CWBTC: { send: "150000000", receive: "0" } });
  });

  test("reads at most MAX_LIQUIDITY_ASSETS entries from a node tab", () => {
    const raw = Object.fromEntries(Array.from({ length: MAX_LIQUIDITY_ASSETS + 10 }, (_, i) => [`T${String(i).padStart(3, "0")}`, { send: "1", receive: "1" }]));
    expect(Object.keys(readLiquidity(raw))).toHaveLength(MAX_LIQUIDITY_ASSETS);
  });

  test("a channel is anything to send or room to receive", () => {
    expect(hasChannel({ CKB: { send: "100", receive: "0" } })).toBe(true);
    expect(hasChannel({ CKB: { send: "0", receive: "0" } })).toBe(false);
    expect(hasChannel({})).toBe(false);
  });

  test("rows follow the hub's assets, formatted in whole units", () => {
    const assets = [
      { id: "CKB", symbol: "CKB", decimals: 8 },
      { id: "RUSD", symbol: "RUSD", decimals: 8 },
    ] satisfies Pick<AssetDto, "id" | "symbol" | "decimals">[];
    expect(liquidityRows({ CKB: { send: CKB(1_000), receive: "150000000" } }, assets)).toEqual([
      { id: "CKB", symbol: "CKB", send: "1,000", receive: "1.5" },
    ]);
    expect(liquidityRows(null, assets)).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------- invoice check */

test.describe("Fiber wallet invoice check", () => {
  test("accepts an invoice of the hub's network for exactly the amount", () => {
    expect(checkNodeInvoice(demoFiberInvoice("testnet", BigInt(CKB(1_000))), request())).toEqual({ ok: true });
  });

  test("skips the network check when the hub did not name one", () => {
    expect(checkNodeInvoice(demoFiberInvoice("devnet", BigInt(CKB(1_000))), request({ network: null }))).toEqual({ ok: true });
  });

  test("refuses another network, no amount, another amount and garbage", () => {
    expect(checkNodeInvoice(demoFiberInvoice("devnet", BigInt(CKB(1_000))), request())).toEqual({
      ok: false,
      error: FIBER_WALLET_MESSAGE.INVOICE_WRONG_NETWORK("devnet", "testnet"),
    });
    expect(checkNodeInvoice(demoFiberInvoice("testnet", null), request())).toEqual({ ok: false, error: FIBER_WALLET_MESSAGE.INVOICE_NO_AMOUNT });
    expect(checkNodeInvoice(demoFiberInvoice("testnet", BigInt(CKB(999))), request())).toEqual({
      ok: false,
      error: FIBER_WALLET_MESSAGE.INVOICE_WRONG_AMOUNT,
    });
    expect(checkNodeInvoice("lntbs1garbage", request())).toEqual({ ok: false, error: FIBER_WALLET_MESSAGE.INVOICE_UNREADABLE });
  });
});

/* ------------------------------------------------------------------------------- browser node over a fake bridge */

/** A bridge that answers as the test says, and records what it was asked. */
class FakeBridge implements BrowserNodePort {
  readonly invoices: MakeInvoiceParams[] = [];
  readonly payments: PayInvoiceParams[] = [];
  invoice = demoFiberInvoice("testnet", BigInt(CKB(1_000)));
  payAnswers: (() => Promise<{ paymentHash: string; status: string }>)[] = [];

  async makeInvoice(params: MakeInvoiceParams) {
    this.invoices.push(params);
    return { invoice: this.invoice, paymentHash: "ab".repeat(32) };
  }

  payInvoice(params: PayInvoiceParams) {
    this.payments.push(params);
    const next = this.payAnswers.shift();
    return next ? next() : Promise.resolve({ paymentHash: "cd".repeat(32), status: "Inflight" });
  }
}

const refuse = (code: (typeof BRIDGE_ERROR)[keyof typeof BRIDGE_ERROR]) => () => Promise.reject(new BridgeError(code, `node said ${code}`));

test.describe("browser node wallet", () => {
  test("asks the node for the payout invoice and returns it once checked", async () => {
    const bridge = new FakeBridge();
    const wallet = new BrowserNodeWallet(bridge);
    const r = request();
    await expect(wallet.makeInvoice(r)).resolves.toBe(bridge.invoice);
    expect(bridge.invoices).toEqual([{ asset: r.asset, amount: r.amount, quoteExpiresAt: r.quoteExpiresAt, network: r.network }]);
  });

  test("refuses an invoice the node made for another amount", async () => {
    const bridge = new FakeBridge();
    bridge.invoice = demoFiberInvoice("testnet", BigInt(CKB(5)));
    await expect(new BrowserNodeWallet(bridge).makeInvoice(request())).rejects.toThrow(FIBER_WALLET_MESSAGE.INVOICE_WRONG_AMOUNT);
  });

  test("passes the node's refusal on", async () => {
    const bridge = new FakeBridge();
    bridge.makeInvoice = () => Promise.reject(new BridgeError(BRIDGE_ERROR.NO_INBOUND, "Your node cannot receive this much CKB yet."));
    await expect(new BrowserNodeWallet(bridge).makeInvoice(request())).rejects.toThrow("cannot receive");
  });

  test("pays a swap once: a second call while the first runs, or after it, sends nothing", async () => {
    const bridge = new FakeBridge();
    const wallet = new BrowserNodeWallet(bridge);
    const pay = { swapId: "s1", invoice: "fibt1hold" };
    const first = wallet.payInvoice(pay);
    const second = wallet.payInvoice(pay);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    await expect(wallet.payInvoice(pay)).resolves.toBeUndefined();
    expect(bridge.payments).toEqual([pay]);
    expect(wallet.paymentFor("s1")).toBeDefined();
    expect(wallet.paymentFor("s2")).toBeUndefined();
  });

  test("a node that did not answer in time counts as sent, and is never asked again", async () => {
    const bridge = new FakeBridge();
    bridge.payAnswers.push(refuse(BRIDGE_ERROR.TIMEOUT));
    const wallet = new BrowserNodeWallet(bridge);
    const pay = { swapId: "s1", invoice: "fibt1hold" };
    await expect(wallet.payInvoice(pay)).resolves.toBeUndefined();
    await expect(wallet.payInvoice(pay)).resolves.toBeUndefined();
    expect(bridge.payments).toHaveLength(1);
  });

  for (const code of [BRIDGE_ERROR.NO_OUTBOUND, BRIDGE_ERROR.REFUSED, BRIDGE_ERROR.NOT_RUNNING, BRIDGE_ERROR.NODE_ERROR]) {
    test(`a node that answered ${code} sent nothing: the error shows and a retry may pay`, async () => {
      const bridge = new FakeBridge();
      bridge.payAnswers.push(refuse(code));
      const wallet = new BrowserNodeWallet(bridge);
      const pay = { swapId: "s1", invoice: "fibt1hold" };
      await expect(wallet.payInvoice(pay)).rejects.toThrow(`node said ${code}`);
      await expect(wallet.payInvoice(pay)).resolves.toBeUndefined();
      expect(bridge.payments).toHaveLength(2);
    });
  }

  test("an error that is not the node's answer blocks retries: it may have paid", async () => {
    const bridge = new FakeBridge();
    bridge.payAnswers.push(() => Promise.reject(new Error("channel closed")));
    const wallet = new BrowserNodeWallet(bridge);
    const pay = { swapId: "s1", invoice: "fibt1hold" };
    await expect(wallet.payInvoice(pay)).rejects.toThrow("channel closed");
    await expect(wallet.payInvoice(pay)).rejects.toThrow("channel closed");
    expect(bridge.payments).toHaveLength(1);
  });

  test("ManualFiberStep says the own node acts by hand", () => {
    const e = new ManualFiberStep();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ManualFiberStep");
  });
});

/* ---------------------------------------------------------------------------------------- remembered choice */

class MapStore implements KeyValueStore {
  readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

const throwingStore: KeyValueStore = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

test.describe("Fiber wallet remembered choice", () => {
  test("saves, reads and forgets the kind", () => {
    const store = new MapStore();
    expect(readFiberWalletKind(store)).toBeNull();
    saveFiberWalletKind(store, "browser-node");
    expect(store.map.get(FIBER_WALLET_KIND_STORAGE_KEY)).toBe("browser-node");
    expect(readFiberWalletKind(store)).toBe("browser-node");
    saveFiberWalletKind(store, null);
    expect(readFiberWalletKind(store)).toBeNull();
  });

  test("ignores a value that is not a kind, and storage that throws or is missing", () => {
    const store = new MapStore();
    store.setItem(FIBER_WALLET_KIND_STORAGE_KEY, "demo");
    expect(readFiberWalletKind(store)).toBeNull();
    expect(readFiberWalletKind(throwingStore)).toBeNull();
    expect(() => saveFiberWalletKind(throwingStore, "own-node")).not.toThrow();
    expect(readFiberWalletKind(null)).toBeNull();
    expect(() => saveFiberWalletKind(null, "own-node")).not.toThrow();
  });
});

/* ---------------------------------------------------------------------------------------- the Fiber chip */

test.describe("wallet chips", () => {
  test("Fiber: Connect, then the kind: ready, passing, a step to take, or a failure", () => {
    const state = (patch: Partial<FiberWalletState>): FiberWalletState => ({ ...FIBER_WALLET_NONE, ...patch });
    expect(fiberChipView(FIBER_WALLET_NONE)).toEqual({ connected: false });
    expect(fiberChipView(state({ kind: "own-node", label: "External node", ready: true }))).toEqual({
      connected: true,
      name: "External node",
      tone: "ok",
      fiberKind: "own-node",
    });
    const browser = (patch: Partial<FiberWalletState>) => state({ kind: "browser-node", label: "CKBolt node", ...patch });
    expect(fiberChipView(browser({ problem: FIBER_WALLET_PROBLEM.LOOKING }))).toMatchObject({ tone: "wait" });
    // A step the visitor takes is amber ("needs attention"): open, unlock, connect, a channel.
    for (const problem of [
      FIBER_WALLET_PROBLEM.NOT_OPEN,
      FIBER_WALLET_PROBLEM.LOCKED,
      FIBER_WALLET_PROBLEM.OTHER_TAB,
      FIBER_WALLET_PROBLEM.HUB_NOT_CONNECTED,
      FIBER_WALLET_PROBLEM.NO_CHANNEL,
    ]) {
      expect(fiberChipView(browser({ problem })), problem).toMatchObject({ tone: "attention" });
    }
    // A ready node the swap on the card is too big for (can't receive, not enough to send) needs attention too.
    expect(fiberChipView(browser({ ready: true }), true)).toMatchObject({ tone: "attention" });
    expect(fiberChipView(browser({ ready: true }))).toMatchObject({ tone: "ok" });
    // Only a failure is red: the node failed, or the hub runs on another network.
    expect(fiberChipView(browser({ problem: FIBER_WALLET_PROBLEM.FAILED }))).toMatchObject({ tone: "problem" });
    expect(fiberChipView(browser({ problem: FIBER_WALLET_PROBLEM.WRONG_NETWORK("devnet") }))).toMatchObject({ tone: "problem" });
    expect(WALLET_TONE_STATUS).toEqual({ ok: "ok", wait: "pending", attention: "pending", problem: "error" });
    expect(WALLET_TONE_LABEL).toMatchObject({ attention: "needs attention", problem: "not usable" });
  });

  test("names the hub's Lightning network with its nickname", () => {
    expect(hubLightningNetworkName("signet")).toBe("Bitcoin signet (Mutinynet)");
    expect(hubLightningNetworkName("regtest")).toBe("Bitcoin regtest");
    expect(hubLightningNetworkName(null)).toBe("a Bitcoin test network");
  });
});
