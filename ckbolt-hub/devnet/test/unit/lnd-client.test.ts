import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DockerCompose } from "../../scripts/lib/compose";
import { SERVICE } from "../../scripts/lib/devnet.constants";
import { LndNode } from "../../scripts/lib/lnd";
import { CommandError, type CommandRunner } from "../../scripts/lib/process";

/** LndNode over a fake docker: answers lncli by subcommand, records the lncli arguments. */
function lndWith(answers: Record<string, string | Error>): { node: LndNode; lncliCalls: string[][] } {
  const lncliCalls: string[][] = [];
  const runner: CommandRunner = async (command, args) => {
    const lncli = args.slice(args.indexOf("lncli"));
    lncliCalls.push(lncli);
    const answer = answers[lncli[2] ?? ""];
    if (answer instanceof Error) throw answer;
    return { stdout: answer ?? "{}", stderr: "" };
  };
  return { node: new LndNode(SERVICE.LND_USER, new DockerCompose("/p", runner)), lncliCalls };
}

describe("LndNode", () => {
  it("runs lncli on regtest inside its own service", async () => {
    const calls: (readonly string[])[] = [];
    const runner: CommandRunner = async (_command, args) => {
      calls.push(args);
      return { stdout: '{"identity_pubkey":"02aa","synced_to_chain":true,"block_height":1}', stderr: "" };
    };
    await new LndNode(SERVICE.LND_HUB, new DockerCompose("/p", runner)).info();
    assert.deepEqual(calls[0], ["compose", "exec", "-T", "lnd-hub", "lncli", "--network=regtest", "getinfo"]);
  });

  it("treats `already connected` as success and rethrows any other connect error", async () => {
    const already = new CommandError("docker", [], 1, "[lncli] rpc error: code = Unknown desc = already connected to peer: 02aa@172.18.0.4:9735");
    await lndWith({ connect: already }).node.connect("02aa", SERVICE.LND_HUB);

    const refused = new CommandError("docker", [], 1, "dial tcp: connection refused");
    await assert.rejects(lndWith({ connect: refused }).node.connect("02aa", SERVICE.LND_HUB), (error) => error === refused);
  });

  it("dials the peer by compose hostname on the P2P port", async () => {
    const { node, lncliCalls } = lndWith({});
    await node.connect("02aa", SERVICE.LND_HUB);
    assert.deepEqual(lncliCalls[0]?.slice(2), ["connect", "02aa@lnd-hub:9735"]);
  });

  it("adds a hold invoice for a hash it was given, with explicit amount, CLTV delta and expiry", async () => {
    const { node, lncliCalls } = lndWith({ addholdinvoice: '{"payment_request":"lnbcrt1..."}' });
    const request = await node.addHoldInvoice({ paymentHash: "ab".repeat(32), sats: 10_000n, cltvExpiryDelta: 40, expirySeconds: 600 });
    assert.equal(request, "lnbcrt1...");
    assert.deepEqual(lncliCalls[0]?.slice(2), ["addholdinvoice", "--amt=10000", "--cltv_expiry_delta=40", "--expiry=600", "ab".repeat(32)]);
  });

  it("adds a regular invoice with an amount, or without one when sats is null, and an optional CLTV delta", async () => {
    const added = '{"r_hash":"aa","payment_request":"lnbcrt1..."}';
    const { node, lncliCalls } = lndWith({ addinvoice: added });
    assert.deepEqual(await node.addInvoice({ sats: 2_000n, expirySeconds: 600, cltvExpiryDelta: 40 }), { r_hash: "aa", payment_request: "lnbcrt1..." });
    await node.addInvoice({ sats: null, expirySeconds: 600 });
    assert.deepEqual(lncliCalls[0]?.slice(2), ["addinvoice", "--expiry=600", "--amt=2000", "--cltv_expiry_delta=40"]);
    assert.deepEqual(lncliCalls[1]?.slice(2), ["addinvoice", "--expiry=600"]);
  });

  it("cancels an invoice by its payment hash", async () => {
    const { node, lncliCalls } = lndWith({ cancelinvoice: "{}" });
    await node.cancelInvoice("ab".repeat(32));
    assert.deepEqual(lncliCalls[0]?.slice(2), ["cancelinvoice", "ab".repeat(32)]);
  });

  it("pays with a fee limit and a timeout and never asks for confirmation", async () => {
    const { node, lncliCalls } = lndWith({ payinvoice: "done" });
    await node.payInvoice("lnbcrt1...", { feeLimitSats: 100n, timeoutSeconds: 60 });
    assert.deepEqual(lncliCalls[0]?.slice(2), ["payinvoice", "--force", "--json", "--fee_limit=100", "--timeout=60s", "lnbcrt1..."]);
  });

  it("finds a payment by hash among incomplete ones too, and returns undefined when missing", async () => {
    const payments = JSON.stringify({ payments: [{ payment_hash: "aa", status: "IN_FLIGHT", payment_preimage: "" }] });
    const { node, lncliCalls } = lndWith({ listpayments: payments });
    assert.equal((await node.findPayment("aa"))?.status, "IN_FLIGHT");
    assert.equal(await node.findPayment("bb"), undefined);
    assert.deepEqual(lncliCalls[0]?.slice(2), ["listpayments", "--include_incomplete"]);
  });

  it("bakes a macaroon with exactly the given permissions into the regtest macaroon directory", async () => {
    const { node, lncliCalls } = lndWith({ bakemacaroon: "0201..." });
    const path = await node.bakeMacaroon(["info:read", "invoices:write"], "demo.macaroon");
    assert.equal(path, "/root/.lnd/data/chain/bitcoin/regtest/demo.macaroon");
    assert.deepEqual(lncliCalls[0]?.slice(2), ["bakemacaroon", `--save_to=${path}`, "info:read", "invoices:write"]);
  });

  it("reads the confirmed wallet balance as a bigint", async () => {
    const { node } = lndWith({ walletbalance: '{"confirmed_balance":"2500000000000"}' });
    assert.equal(await node.confirmedBalanceSats(), 2_500_000_000_000n);
  });
});
