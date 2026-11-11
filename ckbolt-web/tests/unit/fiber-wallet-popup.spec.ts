import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { ccc } from "@ckb-ccc/core";
import { presenceOf, type BridgeContext } from "../../components/app/fiber-node/use-bridge-server";
import { normalizeAmountInput } from "../../lib/amount";
import { isClientNavigable } from "../../lib/site-links";
import { swapLiquidity } from "../../lib/wallets/fiber-browser/channels";
import { CkbRpcClient, readUdtAmount } from "../../lib/wallets/fiber-browser/ckb-rpc";
import { hubNodeIdsOf, readKnownHubNodeId, rememberHubNodeId } from "../../lib/wallets/fiber-browser/hub-link";
import type { BrowserFiberNode, NodeChannel } from "../../lib/wallets/fiber-browser/node-port";
import { connectAndOpenChannel, isPeerNotReady, PEER_CONNECT_MESSAGE, type PeerConnectDeps } from "../../lib/wallets/fiber-browser/peer-connect";
import type { KeyValueStore } from "../../lib/wallets/fiber-browser/storage";
import type { AssetDto, FiberNodeDto, Script } from "../../lib/hub/contract";
import { demoFiberInvoice } from "../../lib/payment-request";
import { activityLabel, holdsNode } from "../../lib/wallets/fiber-browser/activity";
import { FiberJsNode, type FiberLike } from "../../lib/wallets/fiber-browser/fiber-js-adapter";
import { fiberWalletWindowHref, isWalletWindowQuery } from "../../lib/wallets/fiber-browser/links";
import { formatShortUnits, formatTokenAmount, parseNodeId, parseTokenAmount, walletTokens, type WalletToken } from "../../lib/wallets/fiber-browser/tokens";
import { checkPeerChannel, ckbNeededToOpen, type PeerChannelInput } from "../../lib/wallets/fiber-browser/peer-channel";
import { peerIdOf } from "../../lib/wallets/fiber-browser/peer-id";
import { PEER_CHANNEL_MIN_CKB } from "../../lib/wallets/fiber-browser/constants";
import { walletButtonView, walletStateBadge } from "../../lib/wallets/fiber-popup/button-view";
import {
  clampPopupPoint,
  forgetPopupPoint,
  parsePopupPoint,
  POPUP_POSITION,
  popupKeyMove,
  readPopupPoint,
  rememberPopupPoint,
  serializePopupPoint,
} from "../../lib/wallets/fiber-popup/popup-position";
import { popover as popoverClasses } from "../../components/app/fiber-wallet/styles";
import { activityTone, channelStateTone, hubStateTone, nodePhaseTone, outcomeTone, stepTone } from "../../lib/status-tone";
import { nodeStatusTones } from "../../lib/wallets/fiber-wallet/node-status";
import { WALLET_TONE_STATUS } from "../../components/app/swap/wallets/status-dot";
import { FIBER_WALLET_PATH, FIBER_WALLET_WINDOW, WALLET_PAGES, WALLET_RELAY, WALLET_RELAY_TIMING } from "../../lib/wallets/fiber-popup/constants";
import {
  closeMessage,
  focusMessage,
  isFromParentPage,
  isFromWalletFrame,
  navigateMessage,
  openEntryMessage,
  parseRelayMessage,
  pickStatus,
  statusMessage,
  type WalletRelayStatus,
  offersReload,
  relayHealth,
  visibilityMessage,
  type RelayHealth,
} from "../../lib/wallets/fiber-popup/relay";

/*
 * The Fiber node popup's pure logic (docs/fiber-wallet-popup.md): the node's commands as fnn takes them, amounts typed
 * and shown, a channel with another node, the header button's states, and the postMessage relay between the page and
 * the popup's iframe (origin and source checks, nothing secret).
 */

const SHANNONS = BigInt(100_000_000);
const ckb = (whole: number): bigint => BigInt(whole) * SHANNONS;
const NOW = Date.parse("2026-10-27T10:00:00Z");
const RUSD_SCRIPT: Script = {
  codeHash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hashType: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const HUB_NODE: Pick<FiberNodeDto, "nodeId" | "assets"> = {
  nodeId: "02b6d4e3ab86a2ca2fad6fae0ecb2e1e559e0b911939872a90abdda6d20302be71",
  assets: [
    { id: "CKB", udtTypeScript: null, udtWhitelist: null, peerChannels: null },
    { id: "RUSD", udtTypeScript: RUSD_SCRIPT, udtWhitelist: null, peerChannels: null },
  ],
};
const ASSETS: Pick<AssetDto, "id" | "symbol" | "decimals">[] = [
  { id: "CKB", symbol: "CKB", decimals: 8 },
  { id: "RUSD", symbol: "RUSD", decimals: 8 },
];
const TOKENS = walletTokens(HUB_NODE, ASSETS);
const CKB_TOKEN: WalletToken = { id: "CKB", symbol: "CKB", decimals: 8, udtTypeScript: null };
const RUSD = TOKENS.find((t) => t.id === "RUSD")!;
const OWN_NODE = `03${"11".repeat(32)}`;
const PEER = `03${"cd".repeat(32)}`;
const PAYEE = `02${"5a".repeat(32)}`;

const hexQ = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;

/* ------------------------------------------------------------------------------------------ the node */

test.describe("the node's commands", () => {
  test("the adapter sends send_payment (an invoice alone) and open_channel (CKB or a token) as fnn 0.9.1 takes them", async () => {
    const calls: { name: string; params: unknown }[] = [];
    const answers: Record<string, unknown> = {
      send_payment: { payment_hash: `0x${"cc".repeat(32)}`, status: "Created", fee: "0x0" },
      open_channel: { temporary_channel_id: "0x01" },
    };
    const fiber: FiberLike = {
      start: async () => undefined,
      stop: async () => undefined,
      invokeCommand: async (name, args) => {
        calls.push({ name, params: args?.[0] });
        return answers[name];
      },
    };
    const node = new FiberJsNode(fiber);
    const invoice = demoFiberInvoice("testnet", ckb(5));
    await node.sendPayment(invoice);
    await node.openChannel({ peerId: PEER, fundingAmount: ckb(500), isPublic: false });
    await node.openChannel({ peerId: PEER, fundingAmount: ckb(10), isPublic: false, udtTypeScript: RUSD_SCRIPT });
    expect(calls).toEqual([
      { name: "send_payment", params: { invoice } },
      { name: "open_channel", params: { pubkey: PEER, funding_amount: hexQ(ckb(500)), public: false } },
      {
        name: "open_channel",
        params: { pubkey: PEER, funding_amount: hexQ(ckb(10)), public: false, funding_udt_type_script: { code_hash: RUSD_SCRIPT.codeHash, hash_type: "type", args: RUSD_SCRIPT.args } },
      },
    ]);
  });
});

/* ------------------------------------------------------------------------------------------- amounts */

test.describe("token amounts", () => {
  test("typed amounts become exact base units, in either decimal convention, never rounding away a digit", () => {
    expect(parseTokenAmount("1,234.5", 8)).toBe(BigInt(123_450_000_000));
    expect(parseTokenAmount("1.234,5", 8, ",")).toBe(BigInt(123_450_000_000));
    expect(parseTokenAmount("0.00000001", 8)).toBe(BigInt(1));
    expect(parseTokenAmount("0.000000001", 8)).toBeNull();
    expect(parseTokenAmount("1.5", 0)).toBeNull();
    expect(parseTokenAmount("0", 8)).toBeNull();
    expect(parseTokenAmount("-1", 8)).toBeNull();
    expect(parseTokenAmount("abc", 8)).toBeNull();
    expect(parseTokenAmount("", 8)).toBeNull();
  });

  test("a typed node id reads as fnn takes it: 66 lower-case hex characters without 0x", () => {
    expect(parseNodeId(` 0x${PEER.toUpperCase()} `)).toBe(PEER);
    expect(parseNodeId("hello")).toBeNull();
    expect(parseNodeId(`04${"ab".repeat(32)}`)).toBeNull();
  });

  test("amounts read exactly with their symbol, and shortly for the header button (rounded down, grouped)", () => {
    expect(formatTokenAmount(BigInt(250_000_000), RUSD)).toBe("2.5 RUSD");
    expect(formatTokenAmount("123456789012", CKB_TOKEN)).toBe("1,234.56789012 CKB");
    expect(formatShortUnits("110199999999", 8, 2)).toBe("1,101.99");
    expect(formatShortUnits(ckb(1_101), 8, 2)).toBe("1,101");
    expect(formatShortUnits(BigInt(50_000_000), 8, 2)).toBe("0.5");
    expect(formatShortUnits(BigInt(1), 8, 2)).toBe("0");
    expect(formatShortUnits("0", 8, 2)).toBe("0");
    expect(formatShortUnits(BigInt(1_234_567), 6, 0)).toBe("1");
  });

  test("the node's tokens: CKB, then what the hub lists with a script, with the hub's symbols", () => {
    expect(TOKENS).toEqual([CKB_TOKEN, { id: "RUSD", symbol: "RUSD", decimals: 8, udtTypeScript: RUSD_SCRIPT }]);
    expect(walletTokens(null, [])).toEqual([CKB_TOKEN]);
    expect(walletTokens({ assets: [{ id: "RUSD", udtTypeScript: null, udtWhitelist: null, peerChannels: null }] }, ASSETS)).toEqual([CKB_TOKEN]);
  });
});

/* -------------------------------------------------------------------------------------- other nodes */

test.describe("a channel with another node", () => {
  const input = (overrides: Partial<PeerChannelInput> = {}): PeerChannelInput => ({
    nodeId: PEER,
    address: "/dns4/peer.example/tcp/443/wss",
    amount: "500",
    token: CKB_TOKEN,
    ownNodeId: OWN_NODE,
    hubNodeIds: [HUB_NODE.nodeId],
    tokenBalance: null,
    balance: ckb(600),
    secureOnly: true,
    ...overrides,
  });
  const error = (overrides: Partial<PeerChannelInput>) => {
    const result = checkPeerChannel(input(overrides));
    return result.ok ? null : `${result.field}: ${result.error}`;
  };

  test("dials the node's TLS WebSocket address with its peer id, and funds the channel in CKB or a token", () => {
    expect(checkPeerChannel(input())).toEqual({
      ok: true,
      value: { address: `/dns4/peer.example/tcp/443/wss/p2p/${peerIdOf(PEER)}`, peerId: PEER, asset: "CKB", fundingAmount: ckb(500), udtTypeScript: null },
    });
    const rusd = checkPeerChannel(input({ token: RUSD, amount: "10" }));
    expect(rusd).toMatchObject({ ok: true, value: { asset: "RUSD", fundingAmount: ckb(10), udtTypeScript: RUSD_SCRIPT } });
    // An address that already names the node keeps its id.
    const named = `/dns4/peer.example/tcp/443/wss/p2p/${peerIdOf(PEER)}`;
    expect(checkPeerChannel(input({ address: named }))).toMatchObject({ ok: true, value: { address: named } });
  });

  test("refuses the hub, its own node, a TCP or plain ws address on https, an address of another node, too little or too much CKB", () => {
    expect(error({ nodeId: HUB_NODE.nodeId })).toBe("nodeId: That is the CKBolt hub. Use Open with the hub instead.");
    // Also when the hub is out of reach: its id as last read is still refused.
    expect(error({ nodeId: PAYEE, hubNodeIds: [HUB_NODE.nodeId, PAYEE] })).toBe("nodeId: That is the CKBolt hub. Use Open with the hub instead.");
    expect(error({ nodeId: OWN_NODE })).toBe("nodeId: This is your own node. Enter another node's id.");
    expect(error({ address: "/ip4/1.2.3.4/tcp/8228" })).toBe("address: Enter the node's WebSocket address, such as /dns4/host/tcp/443/wss.");
    expect(error({ address: "/ip4/1.2.3.4/tcp/8229/ws" })).toBe("address: On this https page only TLS addresses work (/wss).");
    expect(error({ address: "/ip4/1.2.3.4/tcp/8229/ws", secureOnly: false })).toBeNull();
    expect(error({ address: `/dns4/peer.example/tcp/443/wss/p2p/${peerIdOf(HUB_NODE.nodeId)}` })).toBe("address: This address names another node than this id.");
    expect(error({ amount: String(PEER_CHANNEL_MIN_CKB - 1) })).toBe("amount: Put in at least 100 CKB: 99 stay as the channel's reserve.");
    expect(error({ amount: "600" })).toBe("amount: Your node needs 601 CKB on chain for this. Add funds first.");
    expect(error({ balance: null })).toBe("amount: Your node needs 501 CKB on chain for this. Add funds first.");
    expect(error({ token: RUSD, amount: "10", balance: ckb(180) })).toBe("amount: Your node needs 181 CKB on chain for this. Add funds first.");
    expect(ckbNeededToOpen(RUSD, ckb(1_000))).toBe(ckb(181));
    // A token channel needs the token on chain too, when the node's token cells could be read.
    expect(error({ token: RUSD, amount: "10", tokenBalance: ckb(5) })).toBe("amount: Your node holds 5 RUSD on chain. Add more first.");
    expect(error({ token: RUSD, amount: "5", tokenBalance: ckb(5) })).toBeNull();
  });
});

/* -------------------------------------------------------------------------------------- the relay */

const STATUS: WalletRelayStatus = { isolated: true, phase: "running", hasKey: true, sendCkb: "110100000000" };
const ORIGIN = "https://ckbolt.example";

test.describe("the postMessage relay between the page and the popup's iframe", () => {
  test("a status carries only the listed fields: a key, a password or an invoice never rides along", () => {
    const leaky = { ...STATUS, fiberKey: "a1".repeat(32), password: "testnet node pass", invoice: "fibt1secret" } as unknown as WalletRelayStatus;
    const message = statusMessage(leaky);
    expect(message).toEqual({ source: WALLET_RELAY.SOURCE, v: WALLET_RELAY.VERSION, kind: "status", status: STATUS });
    const wire = JSON.stringify(message);
    for (const secret of ["a1a1a1", "testnet node pass", "fibt1secret"]) expect(wire).not.toContain(secret);
    // Parsing rebuilds the status from the listed fields as well.
    const received = parseRelayMessage({ ...message, status: { ...STATUS, seed: "word ".repeat(12) }, extra: "x" });
    expect(received).toEqual(message);
    expect(JSON.stringify(received)).not.toContain("word");
  });

  test("anything else is refused: another source or version, an unknown kind, a malformed status", () => {
    const message = statusMessage(STATUS);
    expect(parseRelayMessage({ ...message, source: "someone-else" })).toBeNull();
    expect(parseRelayMessage({ ...message, v: 2 })).toBeNull();
    expect(parseRelayMessage({ ...message, kind: "unlock" })).toBeNull();
    expect(parseRelayMessage("status")).toBeNull();
    expect(parseRelayMessage(null)).toBeNull();
    for (const status of [
      { ...STATUS, phase: "hacked" },
      { ...STATUS, sendCkb: "-1" },
      { ...STATUS, sendCkb: 5 },
      { ...STATUS, isolated: "yes" },
      { ...STATUS, hasKey: undefined },
    ]) {
      expect(pickStatus(status), JSON.stringify(status)).toBeNull();
      expect(parseRelayMessage({ ...message, status })).toBeNull();
    }
    expect(() => statusMessage({ ...STATUS, phase: "hacked" } as unknown as WalletRelayStatus)).toThrow();
    expect(parseRelayMessage(closeMessage())).toEqual(closeMessage());
    expect(parseRelayMessage(focusMessage("last"))).toEqual(focusMessage("last"));
    expect(parseRelayMessage({ ...focusMessage("first"), edge: "middle" })).toBeNull();
  });

  test("the page opens one of the popup's pages by name; a page the popup does not have is refused", () => {
    for (const page of WALLET_PAGES) expect(parseRelayMessage(navigateMessage(page))).toEqual({ ...navigateMessage(page) });
    expect(navigateMessage("channels")).toEqual({ source: WALLET_RELAY.SOURCE, v: WALLET_RELAY.VERSION, kind: "navigate", page: "channels" });
    for (const page of ["send", "receive", "deposit", "activity", "", 3, null]) {
      expect(parseRelayMessage({ ...navigateMessage("home"), page }), String(page)).toBeNull();
    }
    expect(parseRelayMessage({ ...navigateMessage("withdraw"), password: "x" })).toEqual(navigateMessage("withdraw"));
  });

  test("the page opens an entry of the node's History by a swap id or a hash, and nothing else rides along", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const hash = `0x${"ab".repeat(32)}`;
    expect(openEntryMessage({ id, hash })).toEqual({ source: WALLET_RELAY.SOURCE, v: WALLET_RELAY.VERSION, kind: "open-entry", entry: { id, hash } });
    expect(WALLET_RELAY.KIND).not.toHaveProperty("OPEN_SWAP");
    // A hash in capitals reads as the same entry; an id alone or a hash alone is enough.
    expect(parseRelayMessage(openEntryMessage({ id: null, hash: hash.toUpperCase().replace("0X", "0x") }))).toEqual(openEntryMessage({ id: null, hash }));
    expect(parseRelayMessage(openEntryMessage({ id, hash: null }))).toEqual(openEntryMessage({ id, hash: null }));
    // Only the two fields are rebuilt: an invoice, a preimage or a path a page adds never reaches the node.
    const invoice = "lntbs10u1p0xyz";
    const forged = { ...openEntryMessage({ id, hash }), entry: { id, hash, invoice, preimage: "cd".repeat(32), path: "https://evil.example" }, extra: invoice };
    expect(parseRelayMessage(forged)).toEqual(openEntryMessage({ id, hash }));
    expect(JSON.stringify(parseRelayMessage(forged))).not.toContain(invoice);
    // A malformed id or hash is dropped; with neither left, the message is refused.
    expect(parseRelayMessage({ ...openEntryMessage({ id, hash }), entry: { id: "../x", hash } })).toEqual(openEntryMessage({ id: null, hash }));
    for (const entry of [{ id: "../x", hash: null }, { id: null, hash: "ab" }, { id: null, hash: "ab".repeat(32) }, {}, null, "x"]) {
      expect(parseRelayMessage({ ...openEntryMessage({ id, hash: null }), entry }), JSON.stringify(entry)).toBeNull();
    }
    expect(() => openEntryMessage({ id: "x", hash: null })).toThrow();
    expect(parseRelayMessage({ source: WALLET_RELAY.SOURCE, v: WALLET_RELAY.VERSION, kind: "open-swap", swap: { id, hash } })).toBeNull();
  });

  test("the page takes messages only from its own wallet iframe's window, on its own origin", () => {
    const frame = { name: "wallet iframe" };
    expect(isFromWalletFrame({ origin: ORIGIN, source: frame }, { origin: ORIGIN, frame })).toBe(true);
    expect(isFromWalletFrame({ origin: "https://evil.example", source: frame }, { origin: ORIGIN, frame })).toBe(false);
    expect(isFromWalletFrame({ origin: ORIGIN, source: { name: "another frame" } }, { origin: ORIGIN, frame })).toBe(false);
    expect(isFromWalletFrame({ origin: ORIGIN, source: null }, { origin: ORIGIN, frame: undefined })).toBe(false);
    expect(isFromWalletFrame({ origin: ORIGIN, source: undefined }, { origin: ORIGIN, frame: undefined })).toBe(false);
  });

  test("the iframe takes messages only from the page that embeds it, on its own origin, and none when it is not framed", () => {
    const parent = { name: "page" };
    const self = { name: "wallet" };
    expect(isFromParentPage({ origin: ORIGIN, source: parent }, { origin: ORIGIN, parent, self })).toBe(true);
    expect(isFromParentPage({ origin: "null", source: parent }, { origin: ORIGIN, parent, self })).toBe(false);
    expect(isFromParentPage({ origin: ORIGIN, source: self }, { origin: ORIGIN, parent, self })).toBe(false);
    expect(isFromParentPage({ origin: ORIGIN, source: self }, { origin: ORIGIN, parent: self, self })).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------ header button */

test.describe("the header button", () => {
  const status = (overrides: Partial<WalletRelayStatus>): WalletRelayStatus => ({ ...STATUS, ...overrides });

  test("Fiber node until opened or while no key exists, Locked while locked, the CKB a swap can send while it runs", () => {
    expect(walletButtonView(null, "idle")).toEqual({ label: "Fiber node", tone: "off", state: "not opened" });
    expect(walletButtonView(null, "loading")).toEqual({ label: "Fiber node", tone: "pending", state: "loading" });
    // A wallet that stops answering keeps its last label with the problem dot, and says so.
    expect(walletButtonView(null, "unanswered")).toEqual({ label: "Fiber node", tone: "error", state: "not answering" });
    expect(walletButtonView(status({}), "stale")).toEqual({ label: "1,101 CKB", tone: "error", state: "running, can send 1,101 CKB, not answering" });
    expect(walletButtonView(status({ phase: "locked", hasKey: false, sendCkb: null }), "live")).toEqual({ label: "Fiber node", tone: "off", state: "no key yet" });
    expect(walletButtonView(status({ phase: "locked", sendCkb: null }), "live")).toEqual({ label: "Locked", tone: "off", state: "locked" });
    expect(walletButtonView(status({}), "live")).toEqual({ label: "1,101 CKB", tone: "ok", state: "running, can send 1,101 CKB" });
    expect(walletButtonView(status({ sendCkb: "50000000" }), "live").label).toBe("0.5 CKB");
    expect(walletButtonView(status({ phase: "starting", sendCkb: null }), "live").label).toBe("Starting…");
    expect(walletButtonView(status({ phase: "other-tab", sendCkb: null }), "live")).toEqual({ label: "Other tab", tone: "pending", state: "runs in another tab" });
    expect(walletButtonView(status({ phase: "failed", sendCkb: null }), "live")).toEqual({ label: "Failed", tone: "error", state: "failed to start" });
    // Without isolation the wallet opens in a window; the button follows that window's node once it answers.
    expect(walletButtonView(status({ isolated: false, phase: null, hasKey: false, sendCkb: null }), "live")).toEqual({
      label: "Fiber node",
      tone: "off",
      state: "opens in a window",
    });
    expect(walletButtonView(status({ isolated: false }), "live").label).toBe("1,101 CKB");
  });

  test("its accessible name holds the visible label (WCAG 2.5.3)", () => {
    const states: [WalletRelayStatus | null, RelayHealth][] = [
      [null, "idle"],
      [null, "unanswered"],
      [status({ phase: "locked", sendCkb: null }), "live"],
      [status({}), "live"],
      [status({}), "stale"],
      [status({ phase: "starting", sendCkb: null }), "live"],
      [status({ phase: "other-tab", sendCkb: null }), "live"],
      [status({ phase: "failed", sendCkb: null }), "live"],
    ];
    for (const [s, health] of states) {
      const view = walletButtonView(s, health);
      const name = `Fiber node: ${view.state}`.toLowerCase();
      expect(name, view.label).toContain(view.label.replace("…", "").toLowerCase());
    }
  });
});

/* ------------------------------------------------------------------------------- activity, routes */

test.describe("the node's activity and routes", () => {
  test("a swap's leg reads in a word or two and holds the page until done; channels and withdrawals never hold it", () => {
    const invoice = { kind: "swap" as const, status: "Open" as const, swap: { id: null, leg: "invoice" as const, lightningSats: null } };
    const payment = { kind: "swap" as const, status: "Inflight" as const, swap: { id: "s1", leg: "payment" as const, lightningSats: "20000" } };
    expect(activityLabel(invoice)).toBe("Waiting");
    expect(activityLabel({ ...invoice, status: "Paid" })).toBe("Received");
    expect(activityLabel(payment)).toBe("In flight");
    expect(activityLabel({ ...payment, status: "Success" })).toBe("Paid");
    expect(activityLabel({ kind: "channel", status: "Opening" })).toBe("Opening");
    expect(holdsNode(invoice)).toBe(true);
    expect(holdsNode({ ...invoice, status: "Expired" })).toBe(false);
    expect(holdsNode(payment)).toBe(true);
    expect(holdsNode({ ...payment, status: "Failed" })).toBe(false);
    expect(holdsNode({ kind: "channel", status: "Opening" })).toBe(false);
    expect(holdsNode({ kind: "withdraw", status: "Sent" })).toBe(false);
  });

  test("the wallet's window is the node page in the wallet's layout", () => {
    expect(fiberWalletWindowHref()).toBe(`/app/fiber?${FIBER_WALLET_WINDOW.PARAM}=${FIBER_WALLET_WINDOW.VALUE}`);
    expect(isWalletWindowQuery("wallet")).toBe(true);
    expect(isWalletWindowQuery(["wallet", "x"])).toBe(true);
    expect(isWalletWindowQuery(undefined)).toBe(false);
    expect(isWalletWindowQuery("full")).toBe(false);
  });
});

/* ---------------------------------------------------------------------------- relay health, visibility */

test.describe("a wallet that stops answering", () => {
  const { LOAD_TIMEOUT_MS, STALE_MS } = WALLET_RELAY_TIMING;

  test("the page tells loading, live, stale and unanswered apart by the age of the wallet's last status", () => {
    expect(relayHealth({ mountedAt: null, statusAt: null, nowMs: NOW })).toBe("idle");
    expect(relayHealth({ mountedAt: NOW, statusAt: null, nowMs: NOW + LOAD_TIMEOUT_MS })).toBe("loading");
    expect(relayHealth({ mountedAt: NOW, statusAt: null, nowMs: NOW + LOAD_TIMEOUT_MS + 1 })).toBe("unanswered");
    expect(relayHealth({ mountedAt: NOW, statusAt: NOW, nowMs: NOW + STALE_MS })).toBe("live");
    expect(relayHealth({ mountedAt: NOW, statusAt: NOW, nowMs: NOW + STALE_MS + 1 })).toBe("stale");
    // The wallet re-posts well within the stale limit, so a live wallet never reads stale.
    expect(WALLET_RELAY_TIMING.REPOST_MS * 2).toBeLessThan(STALE_MS);
  });

  test("Reload is offered for a wallet that does not answer, never over a node last seen running", () => {
    expect(offersReload(null, "unanswered")).toBe(true);
    expect(offersReload({ ...STATUS, phase: "locked" }, "stale")).toBe(true);
    expect(offersReload(STATUS, "stale")).toBe(false);
    expect(offersReload(null, "loading")).toBe(false);
    expect(offersReload({ ...STATUS, phase: "locked" }, "live")).toBe(false);
  });

  test("the page tells the wallet when the popover hides, with nothing else in the message", () => {
    expect(parseRelayMessage(visibilityMessage(false))).toEqual({ source: WALLET_RELAY.SOURCE, v: WALLET_RELAY.VERSION, kind: "visibility", open: false });
    expect(parseRelayMessage({ ...visibilityMessage(true), password: "x" })).toEqual(visibilityMessage(true));
    expect(parseRelayMessage({ ...visibilityMessage(true), open: "no" })).toBeNull();
  });
});

/* -------------------------------------------------------------------------------- peers and channels */

/** A node whose peers show `delay` list_peers calls after connect_peer, and that refuses open_channel without the peer. */
class PeerNode {
  readonly calls: string[] = [];
  peers: string[] = [];
  private pending = new Map<string, number>();
  constructor(
    private readonly delay: number,
    private readonly known: Record<string, string>,
    private readonly refusals: string[] = [],
  ) {}
  async listPeers() {
    this.calls.push("list_peers");
    for (const [id, left] of this.pending) {
      if (left <= 1) {
        this.pending.delete(id);
        this.peers.push(id);
      } else this.pending.set(id, left - 1);
    }
    return this.peers;
  }
  async connectPeer(address: string) {
    this.calls.push(`connect_peer ${address}`);
    const id = this.known[address];
    if (id) this.pending.set(id, this.delay);
  }
  async openChannel(args: { peerId: string }) {
    this.calls.push(`open_channel ${args.peerId}`);
    const refusal = this.refusals.shift();
    if (refusal) throw refusal;
    if (!this.peers.includes(args.peerId)) throw `ErrorObject { code: ServerError(-32000), message: "waiting for peer to send Init message" }`;
    return { temporaryChannelId: "0x01" };
  }
}

/** A clock that moves only when the code under test sleeps. */
function fakeClock(pollMs = 500, timeoutMs = 15_000): PeerConnectDeps & { slept: number[] } {
  let now = NOW;
  const slept: number[] = [];
  return {
    pollMs,
    timeoutMs,
    slept,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  };
}

test.describe("opening a channel with another node", () => {
  const ADDRESS = `/dns4/peer.example/tcp/443/wss/p2p/${peerIdOf(PEER)}`;
  const plan = { address: ADDRESS, peerId: PEER, asset: "CKB", fundingAmount: ckb(500), udtTypeScript: null } as const;

  test("dials, waits until list_peers shows the peer, then opens the channel once", async () => {
    const node = new PeerNode(3, { [ADDRESS]: PEER });
    const clock = fakeClock();
    await connectAndOpenChannel(node, plan, clock);
    expect(node.calls).toEqual([
      "list_peers",
      `connect_peer ${ADDRESS}`,
      "list_peers",
      "list_peers",
      "list_peers",
      `open_channel ${PEER}`,
    ]);
    expect(clock.slept).toEqual([500, 500]);
  });

  test("a peer already connected is not dialled again", async () => {
    const node = new PeerNode(0, {});
    node.peers = [PEER];
    await connectAndOpenChannel(node, plan, fakeClock());
    expect(node.calls).toEqual(["list_peers", `open_channel ${PEER}`]);
  });

  test("a peer that never shows ends with a plain timeout, and no channel is asked for", async () => {
    const node = new PeerNode(0, {});
    const clock = fakeClock(500, 2_000);
    await expect(connectAndOpenChannel(node, plan, clock)).rejects.toThrow(PEER_CONNECT_MESSAGE.TIMEOUT(2));
    expect(node.calls.filter((c) => c.startsWith("open_channel"))).toEqual([]);
  });

  test("fnn's refusal before the peer's Init is tried once more; any other refusal is passed on", async () => {
    const init = `ErrorObject { code: ServerError(-32000), message: "waiting for peer to send Init message" }`;
    const retried = new PeerNode(0, {}, [init]);
    retried.peers = [PEER];
    await connectAndOpenChannel(retried, plan, fakeClock());
    expect(retried.calls.filter((c) => c.startsWith("open_channel"))).toHaveLength(2);
    expect(isPeerNotReady(init)).toBe(true);
    expect(isPeerNotReady(new Error("Peer not found"))).toBe(true);

    const refused = new PeerNode(0, {}, ["ErrorObject { code: ServerError(-32000), message: \"Invalid UDT type script\" }"]);
    refused.peers = [PEER];
    await expect(connectAndOpenChannel(refused, plan, fakeClock())).rejects.toEqual(
      "ErrorObject { code: ServerError(-32000), message: \"Invalid UDT type script\" }",
    );
    expect(refused.calls.filter((c) => c.startsWith("open_channel"))).toHaveLength(1);
  });
});

test.describe("swap liquidity", () => {
  const channel = (peerId: string, overrides: Partial<NodeChannel> = {}): NodeChannel => ({
    channelId: `0x${peerId.slice(0, 4)}`,
    peerId,
    udtTypeScript: null,
    state: "ChannelReady",
    isPublic: false,
    enabled: true,
    localBalance: ckb(100),
    remoteBalance: ckb(200),
    ...overrides,
  });
  const HUB: FiberNodeDto = { ...HUB_NODE, network: "testnet", addresses: { p2p: [], ws: [] }, inbound: { enabled: true, amounts: {} } };

  test("a swap counts only the hub's channels: one with another node adds nothing", () => {
    const channels = [channel(HUB.nodeId), channel(PEER, { localBalance: ckb(5_000), remoteBalance: ckb(5_000) })];
    expect(swapLiquidity(channels, "CKB", HUB)).toEqual({ send: ckb(100), receive: ckb(200) });
    const ctx = {
      state: { phase: "running", info: null, error: null, exclusive: true },
      node: null,
      network: "testnet",
      hubNode: HUB,
      hubConnected: true,
      channels,
      balance: ckb(1_300),
      contributionCkb: 1_200,
      hub: { getSwap: async () => Promise.reject(new Error("unused")) },
      record: () => undefined,
    } as unknown as BridgeContext;
    expect(presenceOf(ctx).liquidity.CKB).toEqual({ send: ckb(100).toString(), receive: ckb(200).toString() });
    // What the swap card needs to send the visitor to Add funds or to Channels; nothing secret.
    expect(presenceOf(ctx)).toMatchObject({ onChainCkb: ckb(1_300).toString(), contributionCkb: 1_200 });
    expect(presenceOf({ ...ctx, balance: null, contributionCkb: null })).toMatchObject({ onChainCkb: null, contributionCkb: null });
    // A hub on another network has no channel with this node.
    expect(presenceOf({ ...ctx, hubNode: { ...HUB, network: "mainnet" } }).liquidity.CKB).toEqual({ send: "0", receive: "0" });
  });
});

/* ------------------------------------------------------------------------------- the hub's id, tokens */

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

test.describe("what the wallet remembers and reads", () => {
  test("the hub's id is kept per network, so it is refused as another node while the hub is out of reach", () => {
    const store = new MapStore();
    expect(readKnownHubNodeId(store, "testnet")).toBeNull();
    rememberHubNodeId(store, "testnet", `0x${HUB_NODE.nodeId.toUpperCase()}`);
    expect(readKnownHubNodeId(store, "testnet")).toBe(HUB_NODE.nodeId);
    expect(readKnownHubNodeId(store, "mainnet")).toBeNull();
    store.setItem("ckbolt:fiber-browser:testnet:hub-node-id", "not a node id");
    expect(readKnownHubNodeId(store, "testnet")).toBeNull();
    expect(readKnownHubNodeId(null, "testnet")).toBeNull();
    expect(hubNodeIdsOf(HUB_NODE.nodeId, null, `0x${HUB_NODE.nodeId}`, undefined, PEER)).toEqual([HUB_NODE.nodeId, PEER]);
  });

  test("the node's token balance: the first 16 bytes of each token cell, little endian, over every page of get_cells", async () => {
    const le = (n: bigint) => `0x${Array.from({ length: 16 }, (_, i) => ((n >> BigInt(8 * i)) & BigInt(0xff)).toString(16).padStart(2, "0")).join("")}`;
    expect(readUdtAmount(le(ckb(12)))).toBe(ckb(12));
    expect(readUdtAmount(`${le(BigInt(7))}ff`)).toBe(BigInt(7));
    expect(readUdtAmount("0x01")).toBe(BigInt(0));
    expect(readUdtAmount(null)).toBe(BigInt(0));

    const bodies: { method: string; params: unknown[] }[] = [];
    const lock: Script = { codeHash: `0x${"9b".repeat(32)}`, hashType: "type", args: `0x${"ab".repeat(20)}` };
    const rpcScript = (s: Script) => ({ code_hash: s.codeHash, hash_type: s.hashType, args: s.args });
    const cell = (amount: bigint, o: { lock?: Script; type?: Script | null } = {}) => ({
      output: { capacity: "0x0", lock: rpcScript(o.lock ?? lock), type: o.type === null ? null : rpcScript(o.type ?? RUSD_SCRIPT) },
      output_data: le(amount),
    });
    const pages = [
      { objects: [cell(ckb(3)), cell(ckb(4))], last_cursor: "0xaa" },
      { objects: [cell(ckb(5))], last_cursor: "0xbb" },
      { objects: [], last_cursor: "0xbb" },
    ];
    const rpc = new CkbRpcClient("https://rpc.example/", async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: pages[bodies.length - 1] }), { status: 200 });
    });
    expect(await rpc.tokenAmount(lock, RUSD_SCRIPT)).toBe(ckb(12));
    expect(bodies.map((b) => b.method)).toEqual(["get_cells", "get_cells", "get_cells"]);
    expect(bodies[0].params[0]).toMatchObject({ script_type: "lock", filter: { script: { code_hash: RUSD_SCRIPT.codeHash } }, with_data: true });
    expect(bodies.map((b) => b.params[3])).toEqual([null, "0xaa", "0xbb"]);

    // The indexer matches the lock and the type by prefix: cells whose scripts only start with the node's lock or the
    // token's type (another xUDT with flags after the same owner's lock hash, a lock with longer args) are not the
    // node's tokens, nor is a cell with no type or no output. Upper-case hex is the same script.
    const longer = (s: Script, extra: string): Script => ({ ...s, args: `${s.args}${extra}` });
    const mixed = [
      cell(ckb(1)),
      cell(ckb(100), { type: longer(RUSD_SCRIPT, "00000000") }),
      cell(ckb(200), { lock: longer(lock, "01") }),
      cell(ckb(300), { type: { ...RUSD_SCRIPT, hashType: "data1" } }),
      cell(ckb(400), { type: null }),
      { output_data: le(ckb(500)) },
      null,
      cell(ckb(2), { type: { ...RUSD_SCRIPT, args: RUSD_SCRIPT.args.toUpperCase().replace("0X", "0x") } }),
    ];
    let calls = 0;
    const exact = new CkbRpcClient("https://rpc.example/", async () => {
      const objects = calls++ === 0 ? mixed : [];
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { objects, last_cursor: "0xcc" } }), { status: 200 });
    });
    expect(await exact.tokenAmount(lock, RUSD_SCRIPT)).toBe(ckb(3));
  });

  test("a typed amount is normalized as text, so token amounts never pass through a float", () => {
    expect(normalizeAmountInput("12,345,678.12345678")).toBe("12345678.12345678");
    expect(normalizeAmountInput("1.234,5", ",")).toBe("1234.5");
    expect(normalizeAmountInput("x")).toBeNull();
    // 2^53 + 1 shannons: a float would round it.
    expect(parseTokenAmount("90071992.54740993", 8)).toBe(BigInt("9007199254740993"));
    expect(parseTokenAmount(".5", 8)).toBe(BigInt(50_000_000));
    expect(parseTokenAmount("0.000", 8)).toBeNull();
  });
});

/* ---------------------------------------------------------------------------------- links and headers */

test.describe("the site's links and headers", () => {
  test("links to the site's own pages move client-side; the isolated pages, the API and other sites load in full", () => {
    for (const href of ["/", "/app", "/app?mode=swap", "/app/guide", "/app/guide#hub", "/#problem", "/app/fiber/fund?address=ckt1q"]) {
      expect(isClientNavigable(href), href).toBe(true);
    }
    for (const href of ["/app/fiber", "/app/fiber/", "/app/fiber?view=wallet", FIBER_WALLET_PATH, "/api/rate", "#features", "https://texlabs.org", "//evil.example", "mailto:x@y.z"]) {
      expect(isClientNavigable(href), href).toBe(false);
    }
  });

  test("next.config.mjs, matched as Next matches it: only /app/wallet may be framed (by this site), isolated by DIP without COOP", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require("../../next.config.mjs").default as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getPathMatch } = require("next/dist/shared/lib/router/utils/path-match");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { modifyRouteRegex } = require("next/dist/lib/redirect-status");
    const rules = await config.headers();
    /** Every header Next sends for `path`: all matching rules, a later one overriding a key (Next's own options). */
    const sent = (path: string) => {
      const headers = new Map<string, string[]>();
      for (const rule of rules) {
        const match = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true, regexModifier: (regex: string) => modifyRouteRegex(regex) });
        if (match(path) === false) continue;
        for (const { key, value } of rule.headers) headers.set(key.toLowerCase(), [...(headers.get(key.toLowerCase()) ?? []), value]);
      }
      return headers;
    };
    const wallet = sent(FIBER_WALLET_PATH);
    expect(wallet.get("content-security-policy")).toEqual(["frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"]);
    expect(wallet.get("x-frame-options")).toEqual(["SAMEORIGIN"]);
    expect(wallet.get("document-isolation-policy")).toEqual(["isolate-and-credentialless"]);
    expect(wallet.get("cross-origin-opener-policy")).toBeUndefined();
    expect(wallet.get("cross-origin-embedder-policy")).toBeUndefined();
    expect(wallet.get("x-content-type-options")).toEqual(["nosniff"]);
    for (const path of ["/", "/app", "/app/guide", "/app/fiber", "/app/fiber/fund", "/app/wallets", "/app/wallet/x", "/_next/static/chunks/a.js"]) {
      const other = sent(path);
      expect(other.get("x-frame-options"), path).toEqual(["DENY"]);
      expect(other.get("content-security-policy")?.[0], path).toContain("frame-ancestors 'none'");
      expect(other.get("content-security-policy"), path).toHaveLength(1);
    }
    expect(sent("/app/fiber").get("cross-origin-opener-policy")).toEqual(["same-origin"]);
  });
});

/* ------------------------------------------------------------------------------------- status colours */

test.describe("status colours: every state maps to one tone", () => {
  test("the node and its channels: running and Ready green, on the way amber, failed red, locked and closed grey", () => {
    expect(["running", "starting", "other-tab", "failed", "locked"].map((p) => nodePhaseTone(p as Parameters<typeof nodePhaseTone>[0]))).toEqual([
      "ok",
      "pending",
      "pending",
      "error",
      "off",
    ]);
    const states = ["ChannelReady", "NegotiatingFunding", "AwaitingChannelReady", "ShuttingDown", "Closed", "FundingFailed", "Abandoned"];
    expect(states.map(channelStateTone)).toEqual(["ok", "pending", "pending", "pending", "off", "error", "error"]);
  });

  test("a swap's steps and outcome: done and complete green, the current step and refunds amber, failed red, the rest grey", () => {
    expect((["done", "active", "failed", "pending"] as const).map(stepTone)).toEqual(["ok", "pending", "error", "off"]);
    expect((["complete", "refunded", "refund-pending", "cancelling", "cancelled"] as const).map(outcomeTone)).toEqual([
      "ok",
      "pending",
      "pending",
      "pending",
      "off",
    ]);
  });

  test("the node's activity (a swap's legs, channels, withdrawals), the hub and the wallets", () => {
    const leg = (kind: "invoice" | "payment") => (status: string) =>
      activityTone({ kind: "swap", status: status as "Success", swap: { id: null, leg: kind, lightningSats: null } });
    expect(["Success", "Failed", "Inflight", "Created"].map(leg("payment"))).toEqual(["ok", "error", "pending", "pending"]);
    expect(["Paid", "Open", "Received", "Expired", "Cancelled"].map(leg("invoice"))).toEqual(["ok", "pending", "pending", "off", "off"]);
    expect(["Opening", "Open", "Closing", "Closed"].map((status) => activityTone({ kind: "channel", status: status as "Open" }))).toEqual([
      "pending",
      "ok",
      "pending",
      "ok",
    ]);
    expect(activityTone({ kind: "withdraw", status: "Sent" })).toBe("ok");
    expect(hubStateTone("live", false)).toBe("ok");
    expect(hubStateTone("live", true)).toBe("pending");
    expect(hubStateTone("degraded", false)).toBe("pending");
    expect(hubStateTone("offline", false)).toBe("error");
    expect(hubStateTone("off", false)).toBe("off");
    // The swap card's chips keep their own words; their dot follows these tones.
    expect(WALLET_TONE_STATUS).toEqual({ ok: "ok", wait: "pending", attention: "pending", problem: "error" });
  });

  test("the Fiber dialog's status lines, and the popover's state badge", () => {
    const presence = (phase: "running" | "locked", hubConnected: boolean) => ({
      presence: { phase, nodeId: OWN_NODE, network: "testnet", hubConnected, liquidity: {} },
      checking: false,
    });
    expect(nodeStatusTones({ presence: null, checking: true })).toEqual({ node: "pending", hub: null });
    expect(nodeStatusTones({ presence: null, checking: false })).toEqual({ node: "off", hub: null });
    expect(nodeStatusTones(presence("running", true))).toEqual({ node: "ok", hub: "ok" });
    expect(nodeStatusTones(presence("running", false))).toEqual({ node: "ok", hub: "off" });
    expect(nodeStatusTones(presence("locked", false))).toEqual({ node: "off", hub: null });

    const st = (overrides: Partial<WalletRelayStatus>): WalletRelayStatus => ({ ...STATUS, ...overrides });
    expect(walletStateBadge(null, "loading")).toBeNull();
    expect(walletStateBadge(STATUS, "live")).toEqual({ label: "Running", tone: "ok" });
    expect(walletStateBadge(st({ phase: "starting", sendCkb: null }), "live")).toEqual({ label: "Starting…", tone: "pending" });
    expect(walletStateBadge(st({ phase: "locked", sendCkb: null }), "live")).toEqual({ label: "Locked", tone: "off" });
    expect(walletStateBadge(st({ phase: "locked", hasKey: false, sendCkb: null }), "live")).toEqual({ label: "No key yet", tone: "off" });
    expect(walletStateBadge(st({ phase: "failed", sendCkb: null }), "live")).toEqual({ label: "Failed", tone: "error" });
    expect(walletStateBadge(st({ isolated: false, phase: null, sendCkb: null }), "live")).toEqual({ label: "In a window", tone: "off" });
    expect(walletStateBadge(STATUS, "stale")).toEqual({ label: "Not answering", tone: "error" });
    expect(walletStateBadge(null, "unanswered")).toEqual({ label: "Not answering", tone: "error" });
  });
});

/* ------------------------------------------------------------------------------------ moving the popup */

test.describe("moving the popup: where it may go, the keys, and the place kept", () => {
  const box = { width: 380, height: 600 };
  const viewport = { width: 1280, height: 900 };
  const { MARGIN_PX, STEP_PX, BIG_STEP_PX, STORAGE_KEY } = POPUP_POSITION;

  test("inside the viewport it goes where it is put, on whole pixels; past an edge it stops MARGIN_PX from it", () => {
    expect(clampPopupPoint({ x: 400, y: 120 }, box, viewport)).toEqual({ x: 400, y: 120 });
    expect(clampPopupPoint({ x: 400.6, y: 120.4 }, box, viewport)).toEqual({ x: 401, y: 120 });
    expect(clampPopupPoint({ x: -50, y: -9_999 }, box, viewport)).toEqual({ x: MARGIN_PX, y: MARGIN_PX });
    expect(clampPopupPoint({ x: 5_000, y: 5_000 }, box, viewport)).toEqual({ x: 1280 - 380 - MARGIN_PX, y: 900 - 600 - MARGIN_PX });
    expect(clampPopupPoint({ x: 0, y: 0 }, box, viewport, 0)).toEqual({ x: 0, y: 0 });
    // Little room: the margin shrinks to half of what there is. None (never: its height is capped by the viewport): pinned to the start.
    expect(clampPopupPoint({ x: 50, y: 50 }, box, { width: 386, height: 604 })).toEqual({ x: 3, y: 2 });
    expect(clampPopupPoint({ x: 50, y: -5 }, box, { width: 300, height: 500 })).toEqual({ x: 0, y: 0 });
  });

  test("arrow keys step STEP_PX, with Shift BIG_STEP_PX; Home puts it back; any other key is left alone", () => {
    expect(popupKeyMove("ArrowLeft", false)).toEqual({ dx: -STEP_PX, dy: 0 });
    expect(popupKeyMove("ArrowRight", false)).toEqual({ dx: STEP_PX, dy: 0 });
    expect(popupKeyMove("ArrowUp", false)).toEqual({ dx: 0, dy: -STEP_PX });
    expect(popupKeyMove("ArrowDown", false)).toEqual({ dx: 0, dy: STEP_PX });
    expect(popupKeyMove("ArrowLeft", true)).toEqual({ dx: -BIG_STEP_PX, dy: 0 });
    expect(popupKeyMove("ArrowDown", true)).toEqual({ dx: 0, dy: BIG_STEP_PX });
    expect(popupKeyMove("Home", false)).toBe("reset");
    expect(popupKeyMove("Home", true)).toBe("reset");
    for (const key of ["Escape", "Enter", " ", "Tab", "End", "PageUp", "a"]) expect(popupKeyMove(key, false), key).toBeNull();
  });

  test("the place kept is x and y alone, on whole pixels; anything else stored reads as nothing kept", () => {
    expect(parsePopupPoint(null)).toBeNull();
    expect(parsePopupPoint('{"x":12.4,"y":300}')).toEqual({ x: 12, y: 300 });
    expect(parsePopupPoint('{"x":-20,"y":40,"note":"ignored"}')).toEqual({ x: -20, y: 40 });
    expect(serializePopupPoint({ x: 10.2, y: 20.7 })).toBe('{"x":10,"y":21}');
    expect(parsePopupPoint(serializePopupPoint({ x: 1.6, y: -2 }))).toEqual({ x: 2, y: -2 });
    for (const bad of ["", "not json", "null", "[]", "42", '"x"', '{"x":1}', '{"x":"1","y":2}', '{"x":null,"y":0}', '{"x":1,"y":1e9}']) {
      expect(parsePopupPoint(bad), bad).toBeNull();
    }
  });

  test("kept in localStorage under its key; a blocked or full store keeps nothing and never throws", () => {
    const store = new MapStore();
    expect(readPopupPoint(store)).toBeNull();
    rememberPopupPoint(store, { x: 100, y: 50 });
    expect(store.map.get(STORAGE_KEY)).toBe('{"x":100,"y":50}');
    expect(STORAGE_KEY).toBe("ckbolt:fiber-wallet:position");
    expect(readPopupPoint(store)).toEqual({ x: 100, y: 50 });
    forgetPopupPoint(store);
    expect(store.map.has(STORAGE_KEY)).toBe(false);
    expect(readPopupPoint(store)).toBeNull();

    const fail = (name: string) => () => {
      throw new DOMException("blocked", name);
    };
    const broken = { getItem: fail("SecurityError"), setItem: fail("QuotaExceededError"), removeItem: fail("SecurityError") };
    expect(readPopupPoint(broken)).toBeNull();
    expect(() => rememberPopupPoint(broken, { x: 1, y: 1 })).not.toThrow();
    expect(() => forgetPopupPoint(broken)).not.toThrow();
    expect(readPopupPoint(null)).toBeNull();
    expect(() => rememberPopupPoint(null, { x: 1, y: 1 })).not.toThrow();
    expect(() => forgetPopupPoint(null)).not.toThrow();
  });

  test("it moves where it is a panel: the same sm breakpoint as its classes, which globals.css leaves at 40rem", () => {
    expect(POPUP_POSITION.MOVABLE_QUERY).toBe("(min-width: 40rem)");
    expect(popoverClasses).toMatch(/(^| )sm:w-\[380px\]( |$)/);
    expect(popoverClasses).toMatch(/(^| )sm:right-4( |$)/);
    expect(readFileSync("app/globals.css", "utf8")).not.toMatch(/--breakpoint-sm/);
  });
});
