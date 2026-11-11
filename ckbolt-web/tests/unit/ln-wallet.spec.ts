import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { encodeUnsignedBolt11, type Network } from "../../lib/bolt11";
import { API_ERROR_CODE, HUB_PROXY_ERROR_CODE, type LightningInboundChannelDto, type LightningNodeDto } from "../../lib/hub/contract";
import { demoFiberInvoice } from "../../lib/payment-request";
import { WALLET_MESSAGE_MAX_CHARS, WEBLN_DECLINED_CODE } from "../../lib/wallets/lightning/constants";
import { isNoRouteError, WalletAnswerError, walletErrorText, WalletNoAnswerError } from "../../lib/wallets/lightning/errors";
import { hubChannelError, hubChannelStatus, hubOffersChannel, readNodeId, shownHubChannel } from "../../lib/wallets/lightning/hub-channel";
import {
  bolt11Prefix,
  checkHoldInvoice,
  checkPayoutInvoice,
  lightningUri,
  normalizeInvoice,
  outlivesQuote,
  satsToMsat,
} from "../../lib/wallets/lightning/invoice-check";
import { LN_WALLET_MESSAGE } from "../../lib/wallets/lightning/messages";
import { hubNetworkLabel, toNetworkFamily } from "../../lib/wallets/lightning/network";
import { attemptFromAnswer, attemptFromError, canPayAgain, type PayAttempt } from "../../lib/wallets/lightning/pay-attempt";
import { NO_ATTEMPTS, WeblnPayStore } from "../../lib/wallets/lightning/pay-store";
import { findWebLn, isWeblnDeclined, payWithWebln, toWeblnPayError, type WebLnProvider } from "../../lib/wallets/lightning/webln-wallet";
import { rawLightningInvoice as rawInvoice } from "../e2e/fakes/hub";

/*
 * The Lightning side of a live swap (docs/live-swap-ui.md, "One wallet"): any wallet by QR code or pasted invoice. Every
 * pure piece under lib/wallets/lightning: the checks of the visitor's own invoice and of the hub's hold invoice, the
 * browser wallet (WebLN) that may pay a hold invoice once, and a Lightning channel from the hub. Fakes of these for
 * browser tests are in tests/e2e/fakes/lightning-wallet.ts.
 */

/* ------------------------------------------------------------------------------------------- fixtures */

const hex32 = () => randomBytes(32).toString("hex");
const nowSeconds = () => Math.floor(Date.now() / 1000);

const invoice = (o: { network?: Network; sats?: number; hash?: Buffer; expirySeconds?: number; timestamp?: number } = {}) =>
  encodeUnsignedBolt11({
    network: o.network ?? "signet",
    amountSats: o.sats ?? 19_800,
    paymentHash: o.hash ?? randomBytes(32),
    description: "Alby Hub",
    expirySeconds: o.expirySeconds ?? 3_600,
    timestamp: o.timestamp,
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

/** A WebLN provider (window.webln) whose answers a test scripts; records what the page asked. */
function fakeWebln(o: Partial<WebLnProvider> = {}) {
  const calls: { method: string; args: unknown }[] = [];
  const provider: WebLnProvider = {
    enable: async () => {
      calls.push({ method: "enable", args: null });
      return o.enable ? o.enable() : undefined;
    },
    sendPayment: async (pr) => {
      calls.push({ method: "sendPayment", args: pr });
      return o.sendPayment ? o.sendPayment(pr) : { preimage: "ab".repeat(32) };
    },
  };
  return { provider, calls, called: (method: string) => calls.filter((c) => c.method === method) };
}

const reject = (message: string) => async (): Promise<never> => {
  throw new Error(message);
};

/* ------------------------------------------------------------------------------------- the hub's network */

test.describe("the hub's Lightning network", () => {
  test("network names map to the invoice family their prefix shows, and its prefix", () => {
    expect(toNetworkFamily("signet")).toBe("signet");
    expect(toNetworkFamily(" Signet ")).toBe("signet");
    expect(toNetworkFamily("bitcoin")).toBe("mainnet");
    expect(toNetworkFamily("MAINNET")).toBe("mainnet");
    expect(toNetworkFamily("testnet3")).toBe("testnet");
    expect(toNetworkFamily("testnet4")).toBe("testnet");
    expect(toNetworkFamily("regtest")).toBe("regtest");
    expect(toNetworkFamily("liquid")).toBeNull();
    expect(toNetworkFamily("")).toBeNull();
    expect(toNetworkFamily(null)).toBeNull();
    expect(bolt11Prefix("signet")).toBe("lntbs");
    expect(bolt11Prefix("regtest")).toBe("lnbcrt");
    expect(bolt11Prefix("testnet4")).toBe("lntb");
    expect(bolt11Prefix(null)).toBe("ln");
  });

  test("the hub's network is named in sentences, or a test network when it did not say", () => {
    expect(hubNetworkLabel("signet")).toBe("Bitcoin signet");
    expect(hubNetworkLabel(null)).toBe("a Bitcoin test network");
    expect(hubNetworkLabel("  ")).toBe("a Bitcoin test network");
  });
});

/* -------------------------------------------------------------------------------- the visitor's invoice */

test.describe("checkPayoutInvoice: the visitor's own invoice (CKB or RUSD to BTC)", () => {
  const SIGNET = { hubNetwork: "signet", nowMs: Date.now() };
  const refused = (line: string, detail: string | null = null) => ({ ok: false, line, detail });

  test("an invoice on the hub's network with a whole number of sats fixes the swap: its amount, hash and expiry", () => {
    const hash = randomBytes(32);
    const now = nowSeconds();
    const text = invoice({ sats: 2_475, hash, timestamp: now, expirySeconds: 600 });
    expect(checkPayoutInvoice(text, SIGNET)).toEqual({
      ok: true,
      value: { invoice: text, sats: "2475", paymentHash: hash.toString("hex"), expiresAtMs: (now + 600) * 1000 },
    });
    // Pasted or scanned: a lightning: link, spaces, an upper-case QR code or a BIP21 link with one is read too, and
    // the hub gets the plain invoice in lower case.
    for (const wrapped of [` lightning:${text} \n`, text.toUpperCase(), `LIGHTNING:${text.toUpperCase()}`, `bitcoin:tb1qexample?amount=0.00002475&lightning=${text}`]) {
      expect(checkPayoutInvoice(wrapped, SIGNET), wrapped.slice(0, 20)).toMatchObject({ ok: true, value: { invoice: text, sats: "2475" } });
    }
    // The devnet hub runs regtest; a hub that did not name its network takes any test network here (it checks again).
    expect(checkPayoutInvoice(invoice({ network: "regtest" }), { ...SIGNET, hubNetwork: "regtest" }).ok).toBe(true);
    expect(checkPayoutInvoice(invoice({ network: "testnet" }), { ...SIGNET, hubNetwork: null }).ok).toBe(true);
  });

  test("an invoice without an amount is refused, as the hub refuses it; so is part of a sat", () => {
    expect(checkPayoutInvoice(rawInvoice({ hrp: "lntbs" }), SIGNET)).toEqual(refused(LN_WALLET_MESSAGE.INVOICE_NO_AMOUNT));
    expect(LN_WALLET_MESSAGE.INVOICE_NO_AMOUNT).toBe("This invoice has no amount. Make one with an amount.");
    // 198000010p is 19,800,001 msat; whole sats in any unit pass.
    expect(checkPayoutInvoice(rawInvoice({ hrp: "lntbs198000010p" }), SIGNET)).toEqual(refused(LN_WALLET_MESSAGE.INVOICE_PART_SAT));
    expect(checkPayoutInvoice(rawInvoice({ hrp: "lntbs198000n" }), SIGNET)).toMatchObject({ ok: true, value: { sats: "19800" } });
    expect(checkPayoutInvoice(rawInvoice({ hrp: "lntbs198000000p" }), SIGNET)).toMatchObject({ ok: true, value: { sats: "19800" } });
  });

  test("an invoice on another network than the hub's is refused, mainnet always", () => {
    expect(checkPayoutInvoice(invoice({ network: "mainnet" }), SIGNET)).toEqual(refused("This is a mainnet invoice. Use one on Bitcoin signet."));
    expect(checkPayoutInvoice(invoice({ network: "mainnet" }), { ...SIGNET, hubNetwork: null })).toEqual(
      refused("This is a mainnet invoice. Use one on a Bitcoin test network."),
    );
    expect(checkPayoutInvoice(invoice({ network: "regtest" }), SIGNET)).toEqual(refused("This invoice is for Bitcoin regtest. Use one on Bitcoin signet."));
    expect(checkPayoutInvoice(invoice({ network: "testnet" }), SIGNET)).toMatchObject({ ok: false });
  });

  test("an expired invoice, or one without a payment hash, is refused", () => {
    const now = nowSeconds();
    expect(checkPayoutInvoice(invoice({ timestamp: now - 120, expirySeconds: 60 }), SIGNET)).toEqual(refused(LN_WALLET_MESSAGE.INVOICE_EXPIRED));
    // Payable up to its expiry, not at it.
    expect(checkPayoutInvoice(invoice({ timestamp: now, expirySeconds: 60 }), { ...SIGNET, nowMs: (now + 60) * 1000 }).ok).toBe(false);
    expect(checkPayoutInvoice(invoice({ timestamp: now, expirySeconds: 60 }), { ...SIGNET, nowMs: (now + 59) * 1000 }).ok).toBe(true);
    expect(checkPayoutInvoice(rawInvoice({ hrp: "lntbs198u", hash: null }), SIGNET)).toEqual(refused(LN_WALLET_MESSAGE.INVOICE_NO_HASH));
  });

  test("anything that is not a Lightning invoice gets one line, with the reason behind it when there is one", () => {
    const garbage = checkPayoutInvoice("garbage", SIGNET);
    expect(garbage).toMatchObject({ ok: false, line: LN_WALLET_MESSAGE.INVOICE_NOT_LIGHTNING, detail: expect.stringMatching(/Not recognised/) });
    expect(checkPayoutInvoice(invoice().slice(0, -3) + "qqq", SIGNET)).toMatchObject({ ok: false, detail: expect.stringContaining("checksum") });
    // Lightning addresses are a later item: the reason says so.
    expect(checkPayoutInvoice("satoshi@example.com", SIGNET)).toMatchObject({ ok: false, detail: expect.stringContaining("Lightning address") });
    // A Fiber invoice is an invoice, but not a Lightning one.
    expect(checkPayoutInvoice(demoFiberInvoice("testnet", BigInt(1_000)), SIGNET)).toEqual(refused(LN_WALLET_MESSAGE.INVOICE_NOT_LIGHTNING));
    // Every refusal line fits the card: one or two sentences of at most twelve words.
    for (const line of [
      LN_WALLET_MESSAGE.INVOICE_NOT_LIGHTNING,
      LN_WALLET_MESSAGE.INVOICE_MAINNET("Bitcoin signet"),
      LN_WALLET_MESSAGE.INVOICE_WRONG_NETWORK("Bitcoin regtest", "Bitcoin signet"),
      LN_WALLET_MESSAGE.INVOICE_NO_AMOUNT,
      LN_WALLET_MESSAGE.INVOICE_PART_SAT,
      LN_WALLET_MESSAGE.INVOICE_NO_HASH,
      LN_WALLET_MESSAGE.INVOICE_EXPIRED,
      LN_WALLET_MESSAGE.INVOICE_EXPIRES_TOO_SOON,
    ]) {
      for (const sentence of line.split(/(?<=\.)\s+/)) expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(12);
    }
  });

  test("the invoice must stay payable until the quote expires, as the hub checks (assertInvoiceOutlivesQuote)", () => {
    const quoteEnds = "2026-10-30T10:02:30.000Z";
    const at = Date.parse(quoteEnds);
    expect(outlivesQuote({ expiresAtMs: at }, quoteEnds)).toBe(true);
    expect(outlivesQuote({ expiresAtMs: at + 1 }, quoteEnds)).toBe(true);
    expect(outlivesQuote({ expiresAtMs: at - 1 }, quoteEnds)).toBe(false);
  });
});

/* ---------------------------------------------------------------------------------- the hub's hold invoice */

test.describe("checkHoldInvoice: the hub's hold invoice must match the swap before the page shows or pays it", () => {
  const hash = randomBytes(32);
  const swap = { amountSats: "50000", paymentHash: hash.toString("hex"), hubNetwork: "signet" };

  test("the swap's own invoice passes, whatever the case of the hash", () => {
    const hold = invoice({ sats: 50_000, hash });
    expect(checkHoldInvoice(hold, swap)).toEqual({ ok: true, invoice: hold });
    expect(checkHoldInvoice(hold, { ...swap, paymentHash: swap.paymentHash.toUpperCase() })).toEqual({ ok: true, invoice: hold });
    expect(checkHoldInvoice(` lightning:${hold} `, swap)).toEqual({ ok: true, invoice: hold });
  });

  test("another hash, another amount, another network or no invoice at all is never shown or paid", () => {
    const mismatch = { ok: false, error: "The hub's invoice does not match this swap, so CKBolt does not show it." };
    expect(checkHoldInvoice(invoice({ sats: 50_000 }), swap)).toEqual(mismatch);
    expect(checkHoldInvoice(invoice({ sats: 50_001, hash }), swap)).toEqual(mismatch);
    expect(checkHoldInvoice(invoice({ sats: 5_000, hash }), swap)).toEqual(mismatch);
    expect(checkHoldInvoice(rawInvoice({ hrp: "lntbs", hash }), swap)).toEqual(mismatch);
    expect(checkHoldInvoice(invoice({ sats: 50_000, hash, network: "regtest" }), swap)).toEqual(mismatch);
    expect(checkHoldInvoice(invoice({ sats: 50_000, hash, network: "mainnet" }), { ...swap, hubNetwork: null })).toEqual(mismatch);
    expect(checkHoldInvoice(rawInvoice({ hrp: "lntbs500u", hash: null }), swap)).toEqual(mismatch);
    expect(checkHoldInvoice("fibt1000000001pcsaug6k", swap)).toEqual(mismatch);
    expect(checkHoldInvoice("", swap)).toEqual(mismatch);
  });

  test("the small helpers: a plain invoice, exact millisatoshis, and the link a wallet opens", () => {
    const text = invoice();
    expect(normalizeInvoice(`LIGHTNING:${text}`)).toBe(text);
    expect(satsToMsat("19800")).toBe(BigInt(19_800_000));
    expect(satsToMsat("2100000000000000")).toBe(BigInt("2100000000000000000"));
    expect(lightningUri(text)).toBe(`lightning:${text}`);
  });
});

/* ------------------------------------------------------------------------------------------- errors */

test.describe("wallet errors", () => {
  test("a wallet's refusal and a missing answer are told apart", () => {
    const answered = new WalletAnswerError("User rejected", WEBLN_DECLINED_CODE);
    expect(answered).toBeInstanceOf(Error);
    expect(answered).toMatchObject({ answered: true, code: "USER_REJECTED", name: "WalletAnswerError", message: "User rejected" });
    expect(new WalletNoAnswerError("Prompt was closed")).toMatchObject({ answered: false, name: "WalletNoAnswerError" });
  });

  test("a wallet's text becomes one short sentence; nothing at all becomes the fallback", () => {
    const fallback = LN_WALLET_MESSAGE.WALLET_ERROR_FALLBACK;
    expect(walletErrorText(new Error("no route"), fallback)).toBe("no route.");
    expect(walletErrorText(new Error("Insufficient balance!"), fallback)).toBe("Insufficient balance!");
    expect(walletErrorText(new Error("  line one\n\n line   two  "), fallback)).toBe("line one line two.");
    expect(walletErrorText({ message: "from an object" }, fallback)).toBe("from an object.");
    expect(walletErrorText(new Error(""), fallback)).toBe("the wallet gave no reason.");
    expect(walletErrorText(undefined, fallback)).toBe(fallback);
    expect(walletErrorText("a bare string", fallback)).toBe(fallback);
    const long = "x".repeat(WALLET_MESSAGE_MAX_CHARS + 50);
    expect(walletErrorText(new Error(long), fallback)).toBe(`${"x".repeat(WALLET_MESSAGE_MAX_CHARS)}…`);
    expect(walletErrorText(new Error("x".repeat(WALLET_MESSAGE_MAX_CHARS)), fallback)).toBe(`${"x".repeat(WALLET_MESSAGE_MAX_CHARS)}.`);
  });

  test("LDK's words for no route to the hub are recognised, in any case", () => {
    expect(isNoRouteError(new Error("Failed to send payment: RouteNotFound"))).toBe(true);
    expect(isNoRouteError({ message: "payment failed: PaymentSendingFailed { reason: ... }" })).toBe(true);
    expect(isNoRouteError(new Error("Insufficient balance"))).toBe(false);
    expect(isNoRouteError(undefined)).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------- WebLN */

test.describe("WebLN (window.webln): the browser wallet pays the hold invoice", () => {
  test("findWebLn takes only something that can enable and pay", () => {
    const { provider } = fakeWebln();
    expect(findWebLn({ webln: provider })).toBe(provider);
    expect(findWebLn({ webln: { enable: () => undefined } })).toBeNull();
    expect(findWebLn({ webln: { sendPayment: () => undefined } })).toBeNull();
    expect(findWebLn({ webln: "yes" })).toBeNull();
    expect(findWebLn({})).toBeNull();
    expect(findWebLn(undefined)).toBeNull();
  });

  test("only a refusal means nothing was sent: User rejected or not enabled; a closed prompt may have paid", () => {
    expect(isWeblnDeclined(new Error("User rejected"))).toBe(true);
    expect(isWeblnDeclined(new Error("user REJECTED the payment"))).toBe(true);
    expect(isWeblnDeclined(new Error("Provider must be enabled before calling sendPayment"))).toBe(true);
    expect(isWeblnDeclined(new Error("Prompt was closed"))).toBe(false);
    expect(isWeblnDeclined(new Error("reply timeout: event abc"))).toBe(false);
    expect(isWeblnDeclined(undefined)).toBe(false);
    expect(toWeblnPayError(new Error("User rejected"))).toMatchObject({ answered: true, code: WEBLN_DECLINED_CODE });
    expect(toWeblnPayError(new Error("Prompt was closed"))).toMatchObject({ answered: false, message: "Prompt was closed" });
    expect(toWeblnPayError("odd")).toBeInstanceOf(WalletNoAnswerError);
  });

  test("paying asks the extension to allow the site, then sends the invoice and reads the preimage", async () => {
    const hold = invoice({ sats: 50_000 });
    const webln = fakeWebln();
    expect(await payWithWebln(webln.provider, hold)).toEqual({ status: "paid", preimage: "ab".repeat(32) });
    expect(webln.calls).toEqual([
      { method: "enable", args: null },
      { method: "sendPayment", args: hold },
    ]);
    const silent = fakeWebln({ sendPayment: async () => ({}) });
    expect(await payWithWebln(silent.provider, hold)).toEqual({ status: "paid", preimage: null });
  });

  test("a refused enable() is the extension saying no, and nothing is sent", async () => {
    const webln = fakeWebln({ enable: reject("User rejected") });
    await expect(payWithWebln(webln.provider, invoice())).rejects.toMatchObject({ answered: true, message: LN_WALLET_MESSAGE.WEBLN_REFUSED });
    expect(webln.called("sendPayment")).toEqual([]);
  });

  test("a payment refusal can be retried; a closed prompt or a timeout cannot", async () => {
    const hold = invoice({ sats: 50_000 });
    await expect(payWithWebln(fakeWebln({ sendPayment: reject("User rejected") }).provider, hold)).rejects.toBeInstanceOf(WalletAnswerError);
    await expect(payWithWebln(fakeWebln({ sendPayment: reject("Prompt was closed") }).provider, hold)).rejects.toBeInstanceOf(WalletNoAnswerError);
    await expect(payWithWebln(fakeWebln({ sendPayment: reject("reply timeout: event abc") }).provider, hold)).rejects.toBeInstanceOf(WalletNoAnswerError);
  });
});

/* -------------------------------------------------------------------------------------- pay attempts */

test.describe("pay attempts: what the browser wallet answered, never the swap's state", () => {
  test("answers and errors map to the four attempt states", () => {
    expect(attemptFromAnswer({ status: "paid", preimage: "ab" })).toEqual({ status: "paid", preimage: "ab" });
    expect(attemptFromError(new WalletAnswerError("User rejected", WEBLN_DECLINED_CODE))).toEqual({ status: "declined", message: "User rejected.", noRoute: false });
    expect(attemptFromError(new WalletAnswerError("", WEBLN_DECLINED_CODE))).toEqual({ status: "declined", message: "the wallet gave no reason.", noRoute: false });
    // LDK's own reasons (Alby Hub): no route to the hub, which a channel from the hub fixes.
    for (const message of ["Failed to send payment: RouteNotFound", "payment failed: PaymentSendingFailed { reason: ... }", "routenotfound"]) {
      expect(attemptFromError(new WalletAnswerError(message, WEBLN_DECLINED_CODE)), message).toMatchObject({ status: "declined", noRoute: true });
    }
    // Only an answer the wallet gave counts: no answer may still be a payment on its way.
    expect(attemptFromError(new WalletNoAnswerError("RouteNotFound"))).toEqual({ status: "uncertain" });
    expect(attemptFromError(new WalletNoAnswerError("Prompt was closed"))).toEqual({ status: "uncertain" });
    // Anything unexpected is treated as maybe sent: the safe side.
    expect(attemptFromError(new Error("boom"))).toEqual({ status: "uncertain" });
  });

  test("only a refusal (or never asking) allows paying again", () => {
    const all: PayAttempt[] = [{ status: "sending" }, { status: "paid", preimage: null }, { status: "uncertain" }];
    for (const attempt of all) expect(canPayAgain(attempt), attempt.status).toBe(false);
    expect(canPayAgain(undefined)).toBe(true);
    expect(canPayAgain({ status: "declined", message: "x.", noRoute: false })).toBe(true);
  });
});

/* ---------------------------------------------------------------------------------------- the store */

test.describe("WeblnPayStore: a hold invoice is never paid twice from this page", () => {
  const HASH = hex32();
  const HOLD = invoice({ sats: 50_000 });

  /** What the store recorded for a payment hash, in any case, as the runner reads it. */
  const attemptOf = (store: WeblnPayStore, hash: string): PayAttempt | undefined => store.getSnapshot()[hash.toLowerCase()];

  function makeStore(provider: WebLnProvider | null) {
    let current = provider;
    const store = new WeblnPayStore({ findWebLn: () => current });
    return { store, setProvider: (p: WebLnProvider | null) => (current = p) };
  }

  test("starts empty; a wallet injected later is seen; listeners hear every change and can leave", async () => {
    const webln = fakeWebln();
    const { store, setProvider } = makeStore(null);
    expect(store.getSnapshot()).toBe(NO_ATTEMPTS);
    expect(store.available()).toBe(false);
    // Without a wallet nothing is asked or recorded.
    await store.pay(HASH, HOLD);
    expect(store.getSnapshot()).toEqual({});
    setProvider(webln.provider);
    expect(store.available()).toBe(true);
    let heard = 0;
    const leave = store.subscribe(() => (heard += 1));
    await store.pay(HASH, HOLD);
    expect(heard).toBe(2);
    leave();
    await store.pay(hex32(), HOLD);
    expect(heard).toBe(2);
  });

  test("the attempt is recorded as sending before the wallet is asked, so a double click pays once", async () => {
    const paid = deferred<{ preimage?: string }>();
    const webln = fakeWebln({ sendPayment: () => paid.promise });
    const { store } = makeStore(webln.provider);
    const one = store.pay(HASH, HOLD);
    const two = store.pay(HASH, HOLD);
    const three = store.pay(HASH.toUpperCase(), HOLD);
    expect(attemptOf(store, HASH)).toEqual({ status: "sending" });
    paid.resolve({ preimage: "ef".repeat(32) });
    await Promise.all([one, two, three]);
    expect(webln.called("sendPayment")).toEqual([{ method: "sendPayment", args: HOLD }]);
    expect(attemptOf(store, HASH)).toEqual({ status: "paid", preimage: "ef".repeat(32) });
    // Paid is final for this page: never again.
    await store.pay(HASH, HOLD);
    expect(webln.called("sendPayment")).toHaveLength(1);
  });

  test("after a refusal the visitor may pay again; after silence never; another swap is another hash", async () => {
    let answer: () => Promise<{ preimage?: string }> = reject("User rejected");
    const webln = fakeWebln({ sendPayment: () => answer() });
    const { store } = makeStore(webln.provider);
    await store.pay(HASH, HOLD);
    expect(attemptOf(store, HASH)).toEqual({ status: "declined", message: "User rejected.", noRoute: false });

    answer = reject("Prompt was closed");
    await store.pay(HASH, HOLD);
    expect(attemptOf(store, HASH)).toEqual({ status: "uncertain" });
    answer = async () => ({ preimage: "00".repeat(32) });
    await store.pay(HASH, HOLD);
    expect(webln.called("sendPayment")).toHaveLength(2);

    const other = hex32();
    await store.pay(other, invoice({ sats: 50_000 }));
    expect(attemptOf(store, other)).toMatchObject({ status: "paid" });
  });

  test("an extension that does not allow the site is a refusal: the visitor may try again", async () => {
    const webln = fakeWebln({ enable: reject("User rejected") });
    const { store } = makeStore(webln.provider);
    await store.pay(HASH, HOLD);
    expect(attemptOf(store, HASH)).toEqual({ status: "declined", message: LN_WALLET_MESSAGE.WEBLN_REFUSED, noRoute: false });
    expect(canPayAgain(attemptOf(store, HASH))).toBe(true);
    expect(webln.called("sendPayment")).toEqual([]);
  });
});

/* --------------------------------------------------------------------- a Lightning channel from the hub */

test.describe("a Lightning channel from the hub", () => {
  const KEY = "02" + "ab".repeat(32);
  const channel = (state: LightningInboundChannelDto["state"], wallet = "20000"): LightningInboundChannelDto => ({
    channelPoint: `${"cd".repeat(32)}:${state.length}`,
    state,
    capacitySats: "30000",
    hubBalanceSats: "10000",
    walletBalanceSats: wallet,
  });
  const node = (patch: Partial<LightningNodeDto> = {}): LightningNodeDto => ({
    pubkey: "03" + "ef".repeat(32),
    network: "signet",
    uris: [`${"03" + "ef".repeat(32)}@203.0.113.10:9735`],
    inbound: { enabled: true, capacitySats: "30000", pushSats: "20000" },
    ...patch,
  });

  test("the pasted node id: 33 bytes of hex as the hub takes it, lower case, or nothing", () => {
    expect(readNodeId(KEY)).toBe(KEY);
    expect(readNodeId(` ${KEY.toUpperCase()} `)).toBe(KEY);
    for (const bad of ["", `0x${KEY}`, KEY.slice(2), "04" + "ab".repeat(32), `${KEY}00`, "zz".repeat(33)]) {
      expect(readNodeId(bad), bad).toBeNull();
    }
  });

  test("offered only while enabled and with an address to add as a peer", () => {
    expect(hubOffersChannel(node())).toBe(true);
    expect(hubOffersChannel(node({ inbound: { enabled: false, capacitySats: "30000", pushSats: "20000" } }))).toBe(false);
    expect(hubOffersChannel(node({ uris: [] }))).toBe(false);
    expect(hubOffersChannel(null)).toBe(false);
  });

  test("the channel shown: ready over opening over closing; Opening right after a request the hub does not list yet", () => {
    expect(shownHubChannel([])).toBeNull();
    expect(shownHubChannel([channel("closing"), channel("opening")])?.state).toBe("opening");
    expect(shownHubChannel([channel("opening"), channel("ready", "19700"), channel("closing")])).toMatchObject({ state: "ready", walletBalanceSats: "19700" });
    expect(hubChannelStatus(null, false)).toBe("none");
    expect(hubChannelStatus(null, true)).toBe("opening");
    expect(hubChannelStatus(channel("ready"), true)).toBe("ready");
  });

  test("the hub's refusals in plain words, with its own sentence behind them", () => {
    const cases: [string, string][] = [
      [API_ERROR_CODE.INBOUND_DISABLED, LN_WALLET_MESSAGE.CHANNEL_DISABLED],
      [API_ERROR_CODE.RATE_LIMITED, LN_WALLET_MESSAGE.CHANNEL_LIMIT],
      [API_ERROR_CODE.CONFLICT, LN_WALLET_MESSAGE.CHANNEL_ADD_PEER],
      [API_ERROR_CODE.INSUFFICIENT_LIQUIDITY, LN_WALLET_MESSAGE.CHANNEL_NO_FUNDS],
      [API_ERROR_CODE.MAINTENANCE, LN_WALLET_MESSAGE.CHANNEL_PAUSED],
      [API_ERROR_CODE.VALIDATION, LN_WALLET_MESSAGE.CHANNEL_KEY_REFUSED],
      [HUB_PROXY_ERROR_CODE.HUB_UNAVAILABLE, LN_WALLET_MESSAGE.CHANNEL_HUB_UNREACHABLE],
      [API_ERROR_CODE.INTERNAL, LN_WALLET_MESSAGE.CHANNEL_FAILED],
    ];
    for (const [code, line] of cases) {
      expect(hubChannelError({ code, message: "The hub's own sentence." }), code).toEqual({ line, detail: "The hub's own sentence." });
    }
    expect(hubChannelError({ code: API_ERROR_CODE.CONFLICT, message: LN_WALLET_MESSAGE.CHANNEL_ADD_PEER })).toEqual({ line: LN_WALLET_MESSAGE.CHANNEL_ADD_PEER, detail: null });
    expect(LN_WALLET_MESSAGE.CHANNEL_ADD_PEER).toBe("Add the hub as a peer in your wallet first, then try again.");
  });
});
