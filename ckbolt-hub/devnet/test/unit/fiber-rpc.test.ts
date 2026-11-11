import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Script } from "../../../src/domain/types";
import { FiberNode } from "../../scripts/lib/fiber";
import { JsonRpcClient, JsonRpcError } from "../../scripts/lib/json-rpc";

interface Received {
  headers: IncomingHttpHeaders;
  body: { jsonrpc: string; id: number; method: string; params: unknown[] };
}

/** A local JSON-RPC endpoint: records every request and answers with the next scripted reply. */
let server: Server;
let url: string;
let received: Received[] = [];
let reply: (request: Received["body"]) => { status?: number; body?: unknown; delayMs?: number } = () => ({ body: { result: null } });

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      const body = JSON.parse(raw) as Received["body"];
      received.push({ headers: req.headers, body });
      const { status = 200, body: answer, delayMs = 0 } = reply(body);
      setTimeout(() => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(answer as object) }));
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  received = [];
  reply = () => ({ body: { result: null } });
});

const RUSD: Script = { codeHash: `0x${"aa".repeat(32)}`, hashType: "data2", args: `0x${"bb".repeat(32)}` };
const HASH = "cd".repeat(32);
const PREIMAGE = "ef".repeat(32);

describe("JsonRpcClient", () => {
  it("posts JSON-RPC 2.0 with increasing ids and no auth header", async () => {
    reply = () => ({ body: { result: { ok: true } } });
    const client = new JsonRpcClient(url, 2_000);
    assert.deepEqual(await client.call("node_info"), { ok: true });
    await client.call("list_peers", [{}]);
    assert.equal(received[0]?.body.jsonrpc, "2.0");
    assert.deepEqual(received[0]?.body.params, []);
    assert.equal(received[1]?.body.id, (received[0]?.body.id ?? 0) + 1);
    assert.match(String(received[0]?.headers["content-type"]), /application\/json/);
    assert.equal(received[0]?.headers.authorization, undefined, "the devnet fnn RPC needs no Biscuit token");
  });

  it("turns a JSON-RPC error into JsonRpcError with method, code, message and data", async () => {
    reply = () => ({ body: { error: { code: -32000, message: "Invalid parameter", data: "final_expiry_delta" } } });
    await assert.rejects(new JsonRpcClient(url, 2_000).call("new_invoice", [{}]), (error: unknown) => {
      assert.ok(error instanceof JsonRpcError);
      assert.equal(error.method, "new_invoice");
      assert.equal(error.code, -32000);
      assert.equal(error.message, 'new_invoice: Invalid parameter ("final_expiry_delta")');
      return true;
    });
  });

  it("reports an HTTP error status", async () => {
    reply = () => ({ status: 503, body: {} });
    await assert.rejects(new JsonRpcClient(url, 2_000).call("node_info"), /node_info: HTTP 503 from http:\/\/127\.0\.0\.1:\d+/);
  });

  it("gives up after its timeout", async () => {
    reply = () => ({ body: { result: 1 }, delayMs: 500 });
    await assert.rejects(new JsonRpcClient(url, 50).call("node_info"), (error: Error) => error.name === "TimeoutError");
  });

  it("fails on an unreachable node", async () => {
    await assert.rejects(new JsonRpcClient("http://127.0.0.1:1", 2_000).call("node_info"));
  });
});

describe("FiberNode requests", () => {
  const node = () => new FiberNode("fnn-hub", new JsonRpcClient(url, 2_000));
  const paramsOf = (index = 0) => received[index]?.body.params[0] as Record<string, unknown>;

  it("creates a sha256 hold invoice for a given hash with hex amounts and an explicit final expiry delta", async () => {
    reply = () => ({ body: { result: { invoice_address: "fibd1..." } } });
    const invoice = await node().newInvoice({
      amount: 10_000_000_000n,
      udtTypeScript: null,
      hashLock: { paymentHash: HASH },
      expirySeconds: 600,
      finalExpiryDeltaMs: 21_600_000,
      description: "d",
    });
    assert.equal(invoice, "fibd1...");
    assert.equal(received[0]?.body.method, "new_invoice");
    assert.deepEqual(paramsOf(), {
      amount: "0x2540be400",
      currency: "Fibd",
      description: "d",
      hash_algorithm: "sha256",
      expiry: "0x258",
      payment_hash: `0x${HASH}`,
      final_expiry_delta: "0x1499700",
    });
  });

  it("creates a normal invoice from a preimage, with the UDT script, and leaves final_expiry_delta to fnn when unset", async () => {
    reply = () => ({ body: { result: { invoice_address: "fibd1..." } } });
    await node().newInvoice({ amount: 1n, udtTypeScript: RUSD, hashLock: { paymentPreimage: PREIMAGE }, expirySeconds: 60, description: "d" });
    const params = paramsOf();
    assert.equal(params.payment_preimage, `0x${PREIMAGE}`);
    assert.equal(params.payment_hash, undefined);
    assert.equal(params.final_expiry_delta, undefined);
    assert.equal(params.hash_algorithm, "sha256");
    assert.deepEqual(params.udt_type_script, { code_hash: RUSD.codeHash, hash_type: RUSD.hashType, args: RUSD.args });
  });

  it("makes an invoice with another hash algorithm only when asked (to test that the hub refuses it)", async () => {
    reply = () => ({ body: { result: { invoice_address: "fibd1..." } } });
    await node().newInvoice({ amount: 1n, udtTypeScript: null, hashLock: { paymentPreimage: PREIMAGE }, expirySeconds: 60, description: "d", hashAlgorithm: "ckb_hash" });
    assert.equal(paramsOf().hash_algorithm, "ckb_hash");
  });

  it("cancels an invoice by its 0x-prefixed hash", async () => {
    await node().cancelInvoice(HASH);
    assert.equal(received[0]?.body.method, "cancel_invoice");
    assert.deepEqual(paramsOf(), { payment_hash: `0x${HASH}` });
  });

  it("settles with 0x-prefixed hash and preimage", async () => {
    await node().settleInvoice(HASH, PREIMAGE);
    assert.equal(received[0]?.body.method, "settle_invoice");
    assert.deepEqual(paramsOf(), { payment_hash: `0x${HASH}`, payment_preimage: `0x${PREIMAGE}` });
  });

  it("opens a public channel, with the UDT script only for a UDT channel", async () => {
    await node().openChannel("02aa", 20_000_000_000_000n, null);
    await node().openChannel("02aa", 10n, RUSD);
    assert.deepEqual(paramsOf(0), { pubkey: "02aa", funding_amount: "0x12309ce54000", public: true });
    assert.deepEqual(paramsOf(1).funding_udt_type_script, { code_hash: RUSD.codeHash, hash_type: RUSD.hashType, args: RUSD.args });
  });

  it("saves a peer it connects to, so the nodes find each other after a restart", async () => {
    await node().connectPeer("/dns4/fnn-user/tcp/8228");
    assert.deepEqual(paramsOf(), { address: "/dns4/fnn-user/tcp/8228", save: true });
  });

  it("asks list_channels for one peer and reads payments and invoices by 0x hash", async () => {
    reply = (request) =>
      request.method === "list_channels" ? { body: { result: { channels: [] } } } : { body: { result: { status: "Received", payment_hash: `0x${HASH}` } } };
    assert.deepEqual(await node().channelsWith("02bb"), []);
    await node().getInvoice(HASH);
    await node().getPayment(`0x${HASH}`);
    assert.deepEqual(paramsOf(0), { pubkey: "02bb" });
    assert.deepEqual(paramsOf(1), { payment_hash: `0x${HASH}` });
    assert.deepEqual(paramsOf(2), { payment_hash: `0x${HASH}` });
  });
});
