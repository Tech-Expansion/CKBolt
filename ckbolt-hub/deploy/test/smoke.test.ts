import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { TESTNET_RUSD_TYPE_SCRIPT } from "../../src/common/constants/assets.constants";
import { FIBER_CURRENCY, FIBER_HASH_ALGORITHM_SHA256, FIBER_MIN_FINAL_EXPIRY_DELTA_MS } from "../../src/common/constants/protocol.constants";
import type { FiberAssetId } from "../../src/domain/types";
import type { CreateQuoteBody, CreateSwapBody } from "../../src/interfaces/http/contract/requests";
import type { LegDto, QuoteDto, SwapDto, SwapEventDto } from "../../src/interfaces/http/contract/responses";
import { MUTINYNET_FAUCET } from "../scripts/lib/constants";
import { renderEvidence, runSmoke, smokeSucceeded, type SmokeEvidence, type SmokeOptions } from "../scripts/smoke/run-smoke";
import { FakeDeployment, type HubRequest } from "./support/fake-deployment";
import { FakeNetwork } from "./support/fake-network";
import { result, testContext, testSettings } from "./support/fakes";

/**
 * testnet:smoke against a scripted hub: the fake hub answers quotes and swaps the way the real one does (the payout
 * invoice's hash is the swap's hash, the preimage is revealed once the swap succeeds), and the demo nodes are the fake
 * LND and fnn of FakeDeployment.
 */

const sha256 = (hex: string): string => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
/** Quote rate of the fake hub: base units of the Fiber asset per sat (0.54 CKB per sat, close to October 2026). */
const UNITS_PER_SAT = 54_000_000n;
/** The preimage of the faucet invoice the fake hub pays in fiber_to_ln (the faucet's node would reveal it). */
const FAUCET_PREIMAGE = "ab".repeat(32);
const HOLD_INVOICE = "lntbs20u1pholdinvoicefromthehub";

interface HubScript {
  /** GET /v1/swaps/:id polls before the swap ends. */
  pollsBeforeEnd: number;
  /** How the swap ends. */
  end: "succeeded" | "failed" | "never";
  failureReason: string;
  /** The hash the hub's swap reports; null: the payout invoice's own hash (what a correct hub does). */
  hashOverride: string | null;
  /** The preimage the hub reveals; null: the real one. */
  preimageOverride: string | null;
  /** An error answer to POST /v1/quotes. */
  quoteError: { status: number; code: string; message: string } | null;
  /** Fixes the receive amount of every quote (base units), to check exact amounts beyond Number's range. */
  receiveAmount: string | null;
}

const EVENTS: SwapEventDto[] = [
  { at: "2026-10-23T10:00:00.000Z", type: "created", detail: "hold invoice made" },
  { at: "2026-10-23T10:00:31.000Z", type: "incoming_accepted", detail: "payment held" },
  { at: "2026-10-23T10:00:40.000Z", type: "payout_succeeded", detail: "preimage learned" },
];

/** Scripts the fake hub of `server` for quotes and swaps; returns what the hub was asked. */
function scriptHub(server: FakeDeployment, overrides: Partial<HubScript> = {}) {
  const script: HubScript = {
    pollsBeforeEnd: 2,
    end: "succeeded",
    failureReason: "payout failed: no route",
    hashOverride: null,
    preimageOverride: null,
    quoteError: null,
    receiveAmount: null,
    ...overrides,
  };
  const quotes = new Map<string, QuoteDto>();
  const swaps = new Map<string, { swap: SwapDto; preimage: string; polls: number }>();
  const quoteBodies: CreateQuoteBody[] = [];
  const swapBodies: CreateSwapBody[] = [];

  const lightningLeg = (amount: string): LegDto => ({ network: "lightning", asset: "BTC", amount, decimals: 0 });
  const fiberLeg = (asset: FiberAssetId, amount: string): LegDto => ({ network: "fiber", asset, amount, decimals: 8 });

  server.hub.route((request: HubRequest) => {
    if (request.method === "POST" && request.path === "/v1/quotes") {
      const body = request.body as CreateQuoteBody;
      quoteBodies.push(body);
      if (script.quoteError) return { status: script.quoteError.status, body: { error: { code: script.quoteError.code, message: script.quoteError.message } } };
      const id = `q-${quotes.size + 1}`;
      const sats = BigInt(body.amount);
      const units = (script.receiveAmount ?? (sats * UNITS_PER_SAT).toString()) as string;
      const quote: QuoteDto = {
        id,
        direction: body.direction,
        asset: body.asset,
        pay: body.direction === "ln_to_fiber" ? lightningLeg(body.amount) : fiberLeg(body.asset, (sats * UNITS_PER_SAT).toString()),
        receive: body.direction === "ln_to_fiber" ? fiberLeg(body.asset, units) : lightningLeg(body.amount),
        prices: { btcUsd: 110_000, assetUsd: 0.0055, source: "fake", at: "2026-10-23T10:00:00.000Z" },
        feeBps: 50,
        purpose: "swap",
        createdAt: "2026-10-23T10:00:00.000Z",
        expiresAt: "2026-10-23T10:03:00.000Z",
        signature: "sig",
        hubPubkey: "pub",
      };
      quotes.set(id, quote);
      return { status: 201, body: quote };
    }
    if (request.method === "POST" && request.path === "/v1/swaps") {
      const body = request.body as CreateSwapBody;
      swapBodies.push(body);
      const quote = quotes.get(body.quoteId);
      if (!quote) return { status: 404, body: { error: { code: "not_found", message: "no such quote" } } };
      const lnToFiber = quote.direction === "ln_to_fiber";
      // ln_to_fiber: the fake fnn's invoices are "fibt1<hash>"; fiber_to_ln: the faucet invoice's preimage is known.
      const preimage = lnToFiber ? demoInvoicePreimage(server) : FAUCET_PREIMAGE;
      const hash = script.hashOverride ?? (lnToFiber ? body.payoutInvoice.replace(/^fibt1/, "") : sha256(FAUCET_PREIMAGE));
      const id = `s-${swaps.size + 1}`;
      const swap: SwapDto = {
        id,
        quoteId: quote.id,
        direction: quote.direction,
        asset: quote.asset,
        state: "pending",
        paymentHash: `0x${hash}`,
        pay: { ...quote.pay, invoice: lnToFiber ? HOLD_INVOICE : `fibt1${hash}` },
        receive: { ...quote.receive, invoice: body.payoutInvoice },
        refunded: false,
        failureReason: null,
        preimage: null,
        demo: false,
        quoteExpiresAt: quote.expiresAt,
        createdAt: quote.createdAt,
        updatedAt: quote.createdAt,
        links: { self: `/v1/swaps/${id}`, events: `/v1/swaps/${id}/events` },
      };
      swaps.set(id, { swap, preimage, polls: 0 });
      return { status: 201, body: swap };
    }
    const events = /^\/v1\/swaps\/([^/]+)\/events$/.exec(request.path);
    if (request.method === "GET" && events) return { status: 200, body: { data: EVENTS } };
    const one = /^\/v1\/swaps\/([^/]+)$/.exec(request.path);
    if (request.method === "GET" && one) {
      const entry = swaps.get(one[1] ?? "");
      if (!entry) return { status: 404, body: { error: { code: "not_found", message: "no such swap" } } };
      entry.polls += 1;
      if (script.end !== "never" && entry.polls > script.pollsBeforeEnd) {
        if (script.end === "succeeded") {
          entry.swap = { ...entry.swap, state: "succeeded", preimage: `0x${script.preimageOverride ?? entry.preimage}` };
          server.fnn["fnn-demo"].invoiceStatus.set(entry.swap.paymentHash.replace(/^0x/, ""), "Paid");
        } else {
          entry.swap = { ...entry.swap, state: "failed", refunded: true, failureReason: script.failureReason };
        }
      }
      return { status: 200, body: entry.swap };
    }
    return undefined;
  });
  return { quoteBodies, swapBodies };
}

/** The preimage fnn-demo was given for its latest invoice (the script creates it, as a user's wallet does). */
function demoInvoicePreimage(server: FakeDeployment): string {
  const calls = server.fnn["fnn-demo"].callsOf("new_invoice");
  const params = calls[calls.length - 1]?.params[0] as { payment_preimage: string } | undefined;
  return (params?.payment_preimage ?? "").replace(/^0x/, "");
}

function smokeSetup(options: { demo?: boolean; settings?: Record<string, string> } = {}) {
  const server = new FakeDeployment({ demo: options.demo ?? true });
  const settings = testSettings(options.settings);
  const network = new FakeNetwork(settings);
  const lndDemo = server.lnd["lnd-demo"];
  lndDemo.pay = (bolt11) =>
    result(JSON.stringify({ payment_hash: "x", status: "SUCCEEDED", payment_preimage: demoInvoicePreimage(server), failure_reason: "FAILURE_REASON_NONE", fee_sat: "2", bolt11 }));
  const context = testContext({ settings, runner: server.runner, http: network.http });
  return { server, network, settings, ...context };
}

const options = (overrides: Partial<SmokeOptions> = {}): SmokeOptions => ({ direction: "both", asset: "CKB", sats: 2_000n, ...overrides });
const only = (evidence: SmokeEvidence[]): SmokeEvidence => {
  assert.equal(evidence.length, 1);
  return evidence[0] as SmokeEvidence;
};

describe("testnet:smoke, BTC to CKB (ln_to_fiber)", () => {
  it("quotes the exact sats, has fnn-demo invoice exactly the quoted receive amount, and lnd-demo pay the hub's hold invoice", async () => {
    const { ctx, server, runner } = smokeSetup();
    const hub = scriptHub(server);
    const evidence = only(await runSmoke(ctx, options({ direction: "ln_to_fiber", sats: 2_000n })));

    assert.deepEqual(hub.quoteBodies, [{ direction: "ln_to_fiber", asset: "CKB", side: "pay", amount: "2000" }]);
    const [invoiceCall] = server.fnn["fnn-demo"].callsOf("new_invoice");
    const invoice = invoiceCall?.params[0] as Record<string, unknown>;
    assert.equal(BigInt(invoice.amount as string), 2_000n * UNITS_PER_SAT, "the payout invoice asks for exactly quote.receive.amount");
    assert.equal(invoice.currency, FIBER_CURRENCY.testnet);
    assert.equal(invoice.hash_algorithm, FIBER_HASH_ALGORITHM_SHA256);
    assert.equal(BigInt(invoice.final_expiry_delta as string), BigInt(FIBER_MIN_FINAL_EXPIRY_DELTA_MS));
    assert.equal(invoice.udt_type_script, undefined, "a CKB invoice has no UDT");
    assert.match(invoice.payment_preimage as string, /^0x[0-9a-f]{64}$/);

    const preimage = (invoice.payment_preimage as string).slice(2);
    const hash = sha256(preimage);
    assert.deepEqual(hub.swapBodies, [{ quoteId: "q-1", payoutInvoice: `fibt1${hash}` }]);

    const pays = server.lnd["lnd-demo"].calls.filter((call) => call[0] === "payinvoice");
    assert.equal(pays.length, 1, "lnd-demo pays once");
    assert.equal(pays[0]?.[pays[0].length - 1], HOLD_INVOICE);
    assert.ok(pays[0]?.includes("--fee_limit=100"));
    assert.ok(pays[0]?.includes("--timeout=120s"));
    assert.ok(pays[0]?.includes("--force"), "never waits on a prompt");
    const payCall = runner.calls.find((call) => call.script?.includes("payinvoice"));
    assert.equal(payCall?.options.timeoutMs, ctx.settings.smoke.timeoutMs, "a hold invoice answers only once settled: the call gets the smoke timeout");

    assert.equal(evidence.direction, "ln_to_fiber");
    assert.equal(evidence.error, null);
    assert.equal(evidence.swap?.state, "succeeded");
    assert.equal(evidence.preimageMatches, true);
    assert.equal(smokeSucceeded(evidence), true);
    assert.deepEqual(evidence.events, EVENTS);
    assert.ok(evidence.observations.some((line) => line.includes(`both legs use hash ${hash}`)));
    assert.ok(evidence.observations.some((line) => /^lnd-demo: payment SUCCEEDED, fee 2 sats/.test(line)));
    assert.ok(evidence.observations.includes("fnn-demo: payout invoice Paid"));
    assert.ok(evidence.observations.includes("the revealed preimage is the one this script created"));
    assert.equal(server.lnd["lnd-hub"].mutatingCalls().length, 0, "the hub's own LND is never driven by the smoke");
  });

  it("prints the evidence: swap, legs, payment hash, preimage, the sha256 check and the hub's events", async () => {
    const { ctx, server } = smokeSetup();
    scriptHub(server);
    const evidence = only(await runSmoke(ctx, options({ direction: "ln_to_fiber" })));
    const text = renderEvidence(evidence);
    const swap = evidence.swap as SwapDto;
    assert.match(text, /^BTC to CKB \(ln_to_fiber\): PASSED/);
    assert.match(text, /swap {10}s-1 \(succeeded\)/);
    assert.match(text, /paid {10}2,?000 BTC|paid {10}2000 BTC/);
    assert.match(text, /received {6}1,?080 CKB/);
    assert.ok(text.includes(`payment hash  ${swap.paymentHash}`));
    assert.ok(text.includes(`preimage      ${swap.preimage}`));
    assert.match(text, /sha256\(preimage\) == payment hash: yes/);
    assert.match(text, /hub events:\n {6}2026-10-23T10:00:00\.000Z {2}created {2}hold invoice made/);
    assert.match(text, /payout_succeeded/);
  });

  it("never pays a hold invoice whose hash is not the payout invoice's (the hub could keep the sats)", async () => {
    const { ctx, server } = smokeSetup();
    scriptHub(server, { hashOverride: "cd".repeat(32) });
    const evidence = only(await runSmoke(ctx, options({ direction: "ln_to_fiber" })));
    assert.match(evidence.error ?? "", /uses hash 0xcdcd.*not the payout invoice's/);
    assert.equal(server.lnd["lnd-demo"].calls.filter((call) => call[0] === "payinvoice").length, 0);
    assert.equal(smokeSucceeded(evidence), false);
    assert.match(renderEvidence(evidence), /FAILED[\s\S]*error: /);
  });

  it("fails when the revealed preimage does not hash to the payment hash, or is not the script's own", async () => {
    const { ctx, server } = smokeSetup();
    scriptHub(server, { preimageOverride: "00".repeat(32) });
    const evidence = only(await runSmoke(ctx, options({ direction: "ln_to_fiber" })));
    assert.equal(evidence.preimageMatches, false);
    assert.match(evidence.error ?? "", /preimage other than the one this script created/);
    assert.equal(smokeSucceeded(evidence), false);
    assert.match(renderEvidence(evidence), /sha256\(preimage\) == payment hash: no/);
  });

  it("reports a swap the hub failed and refunded, with its reason", async () => {
    const { ctx, server } = smokeSetup();
    scriptHub(server, { end: "failed", failureReason: "payout failed: no route" });
    server.lnd["lnd-demo"].pay = () => result("", 1, "[lncli] payment failed: FAILURE_REASON_INCORRECT_PAYMENT_DETAILS");
    const evidence = only(await runSmoke(ctx, options({ direction: "ln_to_fiber" })));
    assert.equal(evidence.swap?.state, "failed");
    assert.equal(evidence.preimageMatches, false);
    assert.equal(smokeSucceeded(evidence), false);
    assert.ok(evidence.observations.some((line) => /lnd-demo: payinvoice ended with .*FAILURE_REASON_INCORRECT_PAYMENT_DETAILS/.test(line)));
    const text = renderEvidence(evidence);
    assert.match(text, /FAILED/);
    assert.match(text, /\(failed, refunded: payout failed: no route\)/);
    assert.match(text, /preimage {6}\(not revealed\)/);
  });

  it("follows the hub's swap state, not the wallet's answer: a pay call that times out still passes when the swap succeeds", async () => {
    const { ctx, server } = smokeSetup();
    scriptHub(server);
    server.lnd["lnd-demo"].pay = () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true });
    const evidence = only(await runSmoke(ctx, options({ direction: "ln_to_fiber" })));
    assert.equal(smokeSucceeded(evidence), true);
    assert.ok(evidence.observations.some((line) => /lnd-demo: payinvoice ended with .*timed out/.test(line)));
  });

  it("gives up after DEPLOY_SMOKE_TIMEOUT_SECONDS when the swap never ends", async () => {
    const { ctx, server, clock } = smokeSetup();
    scriptHub(server, { end: "never" });
    const started = clock.now();
    const evidence = only(await runSmoke(ctx, options({ direction: "ln_to_fiber" })));
    assert.match(evidence.error ?? "", /Timed out after 60 s waiting for swap s-1 to end/);
    assert.equal(clock.now() - started, ctx.settings.smoke.timeoutMs);
    assert.equal(smokeSucceeded(evidence), false);
  });

  it("makes RUSD payout invoices with the RUSD type script", async () => {
    const { ctx, server } = smokeSetup();
    const hub = scriptHub(server);
    only(await runSmoke(ctx, options({ direction: "ln_to_fiber", asset: "RUSD" })));
    assert.equal(hub.quoteBodies[0]?.asset, "RUSD");
    const invoice = server.fnn["fnn-demo"].callsOf("new_invoice")[0]?.params[0] as Record<string, unknown>;
    assert.deepEqual(invoice.udt_type_script, {
      code_hash: TESTNET_RUSD_TYPE_SCRIPT.codeHash,
      hash_type: TESTNET_RUSD_TYPE_SCRIPT.hashType,
      args: TESTNET_RUSD_TYPE_SCRIPT.args,
    });
  });

  it("keeps amounts exact beyond 2^53 base units", async () => {
    const { ctx, server } = smokeSetup();
    const huge = "123456789012345678901";
    scriptHub(server, { receiveAmount: huge });
    only(await runSmoke(ctx, options({ direction: "ln_to_fiber" })));
    const invoice = server.fnn["fnn-demo"].callsOf("new_invoice")[0]?.params[0] as Record<string, unknown>;
    assert.equal(BigInt(invoice.amount as string), BigInt(huge));
  });

  it("stops at a quote the hub refuses, before any invoice or payment", async () => {
    const { ctx, server } = smokeSetup();
    scriptHub(server, { quoteError: { status: 422, code: "amount_out_of_range", message: "above SWAP_MAX_SATS" } });
    const evidence = only(await runSmoke(ctx, options({ direction: "ln_to_fiber", sats: 25_000n })));
    assert.match(evidence.error ?? "", /hub answered 422 amount_out_of_range: above SWAP_MAX_SATS/);
    assert.deepEqual(server.fnn["fnn-demo"].callsOf("new_invoice"), []);
    assert.equal(server.lnd["lnd-demo"].calls.filter((call) => call[0] === "payinvoice").length, 0);
  });
});

describe("testnet:smoke, CKB to BTC (fiber_to_ln)", () => {
  it("asks the Mutinynet faucet for an invoice of exactly the quoted sats, and has fnn-demo pay the hub's Fiber hold invoice", async () => {
    const { ctx, server, network, settings } = smokeSetup();
    const hub = scriptHub(server);
    const evidence = only(await runSmoke(ctx, options({ direction: "fiber_to_ln", sats: 2_500n })));

    assert.deepEqual(hub.quoteBodies, [{ direction: "fiber_to_ln", asset: "CKB", side: "receive", amount: "2500" }]);
    assert.deepEqual(network.faucetInvoiceAmounts(), [2_500]);
    assert.equal(network.http.requests[0]?.url, `${settings.urls.mutinynetFaucet}${MUTINYNET_FAUCET.BOLT11_PATH}`);
    assert.deepEqual(hub.swapBodies, [{ quoteId: "q-1", payoutInvoice: "lntbs2500faucet1" }]);

    const hash = sha256(FAUCET_PREIMAGE);
    const sends = server.fnn["fnn-demo"].callsOf("send_payment");
    assert.deepEqual(sends.map((call) => call.params[0]), [{ invoice: `fibt1${hash}` }], "fnn-demo pays exactly the hub's hold invoice, once");
    assert.ok(server.fnn["fnn-demo"].callsOf("get_payment").every((call) => (call.params[0] as { payment_hash: string }).payment_hash === `0x${hash}`));

    assert.equal(evidence.error, null);
    assert.equal(evidence.preimageMatches, true);
    assert.equal(smokeSucceeded(evidence), true);
    assert.ok(evidence.observations.some((line) => line.includes("payout invoice made by the Mutinynet faucet's node (/api/bolt11)")));
    assert.ok(evidence.observations.includes("fnn-demo: payment Success"));
    assert.match(renderEvidence(evidence), /^CKB to BTC \(fiber_to_ln\): PASSED/);
    assert.deepEqual(server.lnd["lnd-demo"].calls, [], "the Lightning demo node takes no part");
  });

  it("stops when the faucet gives no invoice, before any swap or payment", async () => {
    for (const setup of [(n: FakeNetwork) => (n.bolt11Status = 429), (n: FakeNetwork) => (n.bolt11HasInvoice = false)]) {
      const { ctx, server, network } = smokeSetup();
      const hub = scriptHub(server);
      setup(network);
      const evidence = only(await runSmoke(ctx, options({ direction: "fiber_to_ln" })));
      assert.match(evidence.error ?? "", /Mutinynet faucet invoice for 2000 sats: (HTTP 429|the answer has no bolt11)/);
      assert.deepEqual(hub.swapBodies, []);
      assert.deepEqual(server.fnn["fnn-demo"].callsOf("send_payment"), []);
    }
  });

  it("reports fnn-demo's failed payment and the hub's failed swap", async () => {
    const { ctx, server } = smokeSetup();
    scriptHub(server, { end: "failed", failureReason: "hold invoice expired" });
    server.fnn["fnn-demo"].payments.set(sha256(FAUCET_PREIMAGE), { payment_hash: "x", status: "Failed", failed_error: "Failed to build route" });
    const evidence = only(await runSmoke(ctx, options({ direction: "fiber_to_ln" })));
    assert.equal(smokeSucceeded(evidence), false);
    assert.ok(evidence.observations.includes("fnn-demo: payment Failed (Failed to build route)"));
    assert.match(renderEvidence(evidence), /\(failed, refunded: hold invoice expired\)/);
  });
});

describe("testnet:smoke, both directions and the demo nodes", () => {
  it("runs BTC to CKB, then CKB to BTC, and passes only when both pass", async () => {
    const { ctx, server, logger } = smokeSetup();
    scriptHub(server);
    const evidence = await runSmoke(ctx, options());
    assert.deepEqual(
      evidence.map((e) => e.direction),
      ["ln_to_fiber", "fiber_to_ln"],
    );
    assert.ok(evidence.every(smokeSucceeded));
    assert.match(logger.text(), /BTC to CKB \(ln_to_fiber\), 2000 sats, CKB[\s\S]*CKB to BTC \(fiber_to_ln\), 2000 sats, CKB/);
  });

  it("still runs the second direction when the first one fails", async () => {
    const { ctx, server } = smokeSetup();
    scriptHub(server, { quoteError: { status: 503, code: "unavailable", message: "liquidity" } });
    const evidence = await runSmoke(ctx, options());
    assert.equal(evidence.length, 2);
    assert.ok(evidence.every((e) => !smokeSucceeded(e) && /503 unavailable/.test(e.error ?? "")));
  });

  it("refuses to start without the demo profile, before asking the hub anything", async () => {
    const { ctx, server } = smokeSetup({ demo: false });
    scriptHub(server);
    await assert.rejects(runSmoke(ctx, options()), /demo nodes \(lnd-demo, fnn-demo\).*COMPOSE_PROFILES=demo/);
    assert.deepEqual(server.hub.requests, []);
  });

  it("needs only fnn-demo for CKB to BTC, and names lnd-demo when BTC to CKB lacks it", async () => {
    const { ctx, server } = smokeSetup({ demo: false });
    server.active.push("fnn-demo");
    server.containers.set("fnn-demo", { State: "running", Health: "healthy", Publishers: [] });
    scriptHub(server);
    assert.equal(smokeSucceeded(only(await runSmoke(ctx, options({ direction: "fiber_to_ln" })))), true);
    await assert.rejects(runSmoke(ctx, options({ direction: "ln_to_fiber" })), /demo nodes \(lnd-demo\)/);
  });

  it("reaches the hub through the port Compose publishes (HUB_HOST_PORT), on the server's loopback", async () => {
    const { ctx, server } = smokeSetup();
    server.hubPort = "127.0.0.1:28787";
    scriptHub(server);
    await runSmoke(ctx, options({ direction: "fiber_to_ln" }));
    const urls = server.hub.curlWords.map((words) => words[words.length - 1] ?? "");
    assert.ok(urls.length > 0 && urls.every((url) => url.startsWith("http://127.0.0.1:28787/v1/")), urls.join(", "));
  });
});
