import assert from "node:assert/strict";
import WebSocket from "ws";
import {
  FIBER_INVOICE_ATTR,
  FIBER_PUBSUB,
  FIBER_RPC_METHOD,
  FIBER_TLC_DIRECTION_INBOUND,
  FIBER_TLC_STATE_COMMITTED,
  FIBER_WS_PROTOCOL_BY_HTTP,
  JSON_RPC_VERSION,
} from "../../../src/common/constants/fiber-rpc.constants";
import { FIBER_CURRENCY, FIBER_HASH_ALGORITHM_SHA256, FIBER_MIN_FINAL_EXPIRY_DELTA_MS } from "../../../src/common/constants/protocol.constants";
import { fromHexQuantity } from "../../../src/common/utils/amount.util";
import { with0x } from "../../../src/common/utils/hex.util";
import { BackgroundTask } from "../../scripts/lib/background-task";
import { waitOptions } from "../../scripts/lib/context";
import { LNCLI, SERVICE } from "../../scripts/lib/devnet.constants";
import type { FiberNode, FnnTlc } from "../../scripts/lib/fiber";
import { newPaymentSecret, type PaymentSecret } from "../../scripts/lib/payment-secret";
import { doneWhen, waitFor } from "../../scripts/lib/poll";
import { BELOW_MINIMUM_MARGIN_MS, CHECK_INVOICE_DESCRIPTION, CHECK_INVOICE_EXPIRY_SECONDS, FNN_STATE, LND_STATE } from "./check.constants";
import { requireHubEnv, type LiveContext } from "./live-context";
import type { CheckRunner } from "./runner";

interface ParsedFiberInvoice {
  invoice: { currency: string; data: { payment_hash: string; attrs: Record<string, unknown>[] } };
}

const attr = (parsed: ParsedFiberInvoice, key: string): unknown => parsed.invoice.data.attrs.find((entry) => key in entry)?.[key];

/** Sides of the hub's CKB channel with the user (hub's view), to prove a refund moved nothing. */
async function ckbChannelSides(hub: FiberNode, userPubkey: string): Promise<string> {
  const channel = (await hub.channelsWith(userPubkey)).find((candidate) => candidate.funding_udt_type_script == null);
  assert.ok(channel, "no CKB channel");
  return `${fromHexQuantity(channel.local_balance)}/${fromHexQuantity(channel.remote_balance)}`;
}

/** fnn v0.9.1 reports a TLC's state as `{ <direction>: <state> }`; a removed TLC stays listed (e.g. RemoveAckConfirmed). */
type FnnTlcWithStatus = FnnTlc & { status?: Record<string, string> };

/** True only while the hub's channel holds an inbound, committed TLC for the hash: a removed one does not count. */
async function holdsTlc(hub: FiberNode, userPubkey: string, paymentHash: string): Promise<boolean> {
  const isHeld = (tlc: FnnTlcWithStatus) =>
    tlc.payment_hash === with0x(paymentHash) && tlc.status?.[FIBER_TLC_DIRECTION_INBOUND] === FIBER_TLC_STATE_COMMITTED;
  const channels = await hub.channelsWith(userPubkey);
  return channels.some((channel) => (channel.pending_tlcs as FnnTlcWithStatus[]).some(isHeld));
}

/** fnn-hub holds a CKB payment from fnn-user on a sha256 hold invoice, as in direction B of a swap. */
async function holdFiberPayment(live: LiveContext, secret: PaymentSecret, userPubkey: string): Promise<void> {
  const { fiber } = live;
  const invoice = await fiber.hub.newInvoice({
    amount: live.devnet.settings.smoke.fiberCkbShannons,
    udtTypeScript: null,
    hashLock: { paymentHash: secret.paymentHash },
    expirySeconds: CHECK_INVOICE_EXPIRY_SECONDS,
    finalExpiryDeltaMs: requireHubEnv(live).config.swaps.fiberHoldFinalExpiryDeltaMs,
    description: CHECK_INVOICE_DESCRIPTION,
  });
  await fiber.user.sendPayment(invoice);
  await waitFor(
    "fnn-hub to hold the payment",
    async () => doneWhen((await fiber.hub.getInvoice(secret.paymentHash)).status === FNN_STATE.RECEIVED && (await holdsTlc(fiber.hub, userPubkey, secret.paymentHash))),
    waitOptions(live.devnet),
  );
}

export async function checkProtocol(live: LiveContext, runner: CheckRunner): Promise<void> {
  runner.section("Protocol behaviour the hub relies on");
  if (!(await runner.check("hub.env is available for the protocol checks", async () => void requireHubEnv(live)))) return;
  await checkFiberInvoices(live, runner);
  await checkFiberRefund(live, runner);
  await checkLightningRefund(live, runner);
  await checkPubsub(live, runner);
}

async function checkFiberInvoices(live: LiveContext, runner: CheckRunner): Promise<void> {
  const { hub } = live.fiber;
  const { config } = requireHubEnv(live);

  await runner.check("fnn is a release build: final_expiry_delta below 160 minutes is refused", async () => {
    const { paymentHash } = newPaymentSecret();
    const tooShort = FIBER_MIN_FINAL_EXPIRY_DELTA_MS - BELOW_MINIMUM_MARGIN_MS;
    await assert.rejects(
      hub.newInvoice({ amount: 1n, udtTypeScript: null, hashLock: { paymentHash }, expirySeconds: CHECK_INVOICE_EXPIRY_SECONDS, finalExpiryDeltaMs: tooShort, description: CHECK_INVOICE_DESCRIPTION }),
      /final_expiry_delta/,
    );
  });

  await runner.check("a hub hold invoice parses as sha256, devnet currency, with the hub's final expiry delta", async () => {
    const { paymentHash } = newPaymentSecret();
    const invoice = await hub.newInvoice({
      amount: 1n,
      udtTypeScript: null,
      hashLock: { paymentHash },
      expirySeconds: CHECK_INVOICE_EXPIRY_SECONDS,
      finalExpiryDeltaMs: config.swaps.fiberHoldFinalExpiryDeltaMs,
      description: CHECK_INVOICE_DESCRIPTION,
    });
    try {
      const parsed = await live.rpc.fnnHub.call<ParsedFiberInvoice>(FIBER_RPC_METHOD.PARSE_INVOICE, [{ invoice }]);
      assert.equal(parsed.invoice.currency, FIBER_CURRENCY.devnet);
      assert.equal(parsed.invoice.data.payment_hash, with0x(paymentHash));
      assert.equal(attr(parsed, FIBER_INVOICE_ATTR.HASH_ALGORITHM), FIBER_HASH_ALGORITHM_SHA256);
      assert.equal(fromHexQuantity(String(attr(parsed, FIBER_INVOICE_ATTR.FINAL_EXPIRY_DELTA))), BigInt(config.swaps.fiberHoldFinalExpiryDeltaMs));
    } finally {
      await live.rpc.fnnHub.call(FIBER_RPC_METHOD.CANCEL_INVOICE, [{ payment_hash: with0x(paymentHash) }]);
    }
  });
}

/** Direction B refund: the hub cancels a held Fiber payment; the payer's payment fails and no funds move. */
async function checkFiberRefund(live: LiveContext, runner: CheckRunner): Promise<void> {
  const { fiber } = live;
  const secret = newPaymentSecret();
  const userPubkey = (await fiber.user.nodeInfo()).pubkey;
  const before = await ckbChannelSides(fiber.hub, userPubkey);

  const held = await runner.check("Fiber: fnn-hub holds a payment from fnn-user on a sha256 hold invoice", () => holdFiberPayment(live, secret, userPubkey));
  if (!held) return;

  await runner.check("Fiber: settle_invoice with a wrong preimage is refused and the payment stays held", async () => {
    const wrong = newPaymentSecret().preimage;
    await assert.rejects(fiber.hub.settleInvoice(secret.paymentHash, wrong));
    assert.equal((await fiber.hub.getInvoice(secret.paymentHash)).status, FNN_STATE.RECEIVED);
    assert.ok(await holdsTlc(fiber.hub, userPubkey, secret.paymentHash), "the TLC is gone");
  });

  await runner.check("Fiber: a second invoice for the same payment hash is refused (one hash per swap)", async () => {
    await assert.rejects(
      fiber.hub.newInvoice({ amount: 1n, udtTypeScript: null, hashLock: { paymentHash: secret.paymentHash }, expirySeconds: CHECK_INVOICE_EXPIRY_SECONDS, description: CHECK_INVOICE_DESCRIPTION }),
      /already exists/,
    );
  });

  await runner.check("Fiber: cancel_invoice refunds the payer (payment Failed, TLC removed, balances unchanged)", async () => {
    await live.rpc.fnnHub.call(FIBER_RPC_METHOD.CANCEL_INVOICE, [{ payment_hash: with0x(secret.paymentHash) }]);
    await waitFor("the invoice to be Cancelled", async () => doneWhen((await fiber.hub.getInvoice(secret.paymentHash)).status === FNN_STATE.CANCELLED), waitOptions(live.devnet));
    await waitFor("fnn-user's payment to fail", async () => doneWhen((await fiber.user.getPayment(secret.paymentHash)).status === FNN_STATE.FAILED), waitOptions(live.devnet));
    await waitFor("the TLC to be removed from the channel", async () => doneWhen(!(await holdsTlc(fiber.hub, userPubkey, secret.paymentHash))), waitOptions(live.devnet));
    assert.equal(await ckbChannelSides(fiber.hub, userPubkey), before, "the channel balances moved");
  });
}

/** Direction A refund: the hub cancels a held Lightning payment; the payer's payment fails. */
async function checkLightningRefund(live: LiveContext, runner: CheckRunner): Promise<void> {
  const { lnd, settings, compose } = live.devnet;
  const secret = newPaymentSecret();
  let payer: BackgroundTask | undefined;

  const held = await runner.check("Lightning: lnd-hub holds a payment from lnd-user on a hold invoice (ACCEPTED)", async () => {
    const request = await lnd.hub.addHoldInvoice({ paymentHash: secret.paymentHash, sats: settings.smoke.lnSats, cltvExpiryDelta: settings.smoke.lnCltvExpiryDelta, expirySeconds: CHECK_INVOICE_EXPIRY_SECONDS });
    payer = new BackgroundTask("lnd-user's payment", lnd.user.payInvoice(request, { feeLimitSats: settings.smoke.lnFeeLimitSats, timeoutSeconds: settings.smoke.lnPayTimeoutSeconds }));
    const task = payer;
    await waitFor("ACCEPTED", async () => {
      task.assertRunning();
      return doneWhen((await lnd.hub.lookupInvoice(secret.paymentHash)).state === LND_STATE.ACCEPTED);
    }, waitOptions(live.devnet));
  });
  if (!held || !payer) return;

  await runner.check("Lightning: settling with a wrong preimage is refused and the HTLC stays held", async () => {
    await assert.rejects(lnd.hub.settleInvoice(newPaymentSecret().preimage));
    assert.equal((await lnd.hub.lookupInvoice(secret.paymentHash)).state, LND_STATE.ACCEPTED);
  });

  await runner.check("Lightning: a second invoice for the same payment hash is refused (one hash per swap)", async () => {
    await assert.rejects(
      lnd.hub.addHoldInvoice({ paymentHash: secret.paymentHash, sats: settings.smoke.lnSats, cltvExpiryDelta: settings.smoke.lnCltvExpiryDelta, expirySeconds: CHECK_INVOICE_EXPIRY_SECONDS }),
      /already exists/,
    );
  });

  const task = payer;
  await runner.check("Lightning: cancelling the hold invoice refunds the payer (CANCELED, payment FAILED)", async () => {
    await compose.exec(SERVICE.LND_HUB, [...LNCLI, "cancelinvoice", secret.paymentHash]);
    await waitFor("CANCELED", async () => doneWhen((await lnd.hub.lookupInvoice(secret.paymentHash)).state === LND_STATE.CANCELED), waitOptions(live.devnet));
    await task.result().catch(() => undefined); // lncli payinvoice may exit non-zero on a failed payment; the record decides.
    const payment = await lnd.user.findPayment(secret.paymentHash);
    assert.equal(payment?.status, LND_STATE.FAILED);
  });
}

/** hub.env turns on FIBER_PUBSUB; fnn-hub must accept a subscribe_store_changes WebSocket. */
async function checkPubsub(live: LiveContext, runner: CheckRunner): Promise<void> {
  const { config } = requireHubEnv(live);
  if (!config.fiber.pubsub) return;
  await runner.check("Fiber pubsub: fnn-hub accepts subscribe_store_changes over WebSocket (FIBER_PUBSUB=true)", async () => {
    const url = new URL(config.fiber.rpcUrl);
    url.protocol = FIBER_WS_PROTOCOL_BY_HTTP[url.protocol] ?? url.protocol;
    const reply = await new Promise<{ result?: unknown; error?: { message: string } }>((resolve, reject) => {
      const socket = new WebSocket(url.toString());
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error(`no answer from ${url} within ${live.devnet.settings.waits.rpcTimeoutMs} ms`));
      }, live.devnet.settings.waits.rpcTimeoutMs);
      socket.on("open", () => socket.send(JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id: 1, method: FIBER_PUBSUB.SUBSCRIBE_METHOD, params: [] })));
      socket.on("message", (data) => {
        clearTimeout(timer);
        socket.close();
        resolve(JSON.parse(String(data)) as { result?: unknown; error?: { message: string } });
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    assert.equal(reply.error, undefined, reply.error?.message);
    assert.notEqual(reply.result, undefined);
    return `subscription ${String(reply.result)}`;
  });
}
