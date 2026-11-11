import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TESTNET_RUSD_TYPE_SCRIPT } from "../../src/common/constants/assets.constants";
import { FIBER_MIN_FINAL_EXPIRY_DELTA_MS } from "../../src/common/constants/protocol.constants";
import { ckbAddress, encodeBech32m } from "../scripts/lib/ckb-address";
import { CkbRpc } from "../scripts/lib/ckb-rpc";
import { CkbFaucet, MutinynetFaucet } from "../scripts/lib/faucets";
import {
  announcedPeerId,
  dockerNetworkMultiaddr,
  FiberRpc,
  FiberRpcError,
  hostOfMultiaddr,
  isChannelOfAsset,
  peerIdOf,
  toFnnScript,
  type FnnNodeInfo,
} from "../scripts/lib/fiber";
import { HubApi, HubApiError, parseCurlResponse } from "../scripts/lib/hub-api";
import { RemoteKit } from "../scripts/lib/kit";
import { balancesWith, LndCli } from "../scripts/lib/lnd";
import { waitFor } from "../scripts/lib/poll";
import { RemoteShell } from "../scripts/lib/ssh";
import { fnnChannel, lndChannel, lockOf } from "./support/fake-deployment";
import { FakeClock, FakeHttp, FakeRunner, json, result, shellWords, withoutKitDir, type RecordedCall } from "./support/fakes";

const DIR = "/opt/ckbolt/testnet";
const kitOf = (fake: FakeRunner) => new RemoteKit(DIR, new RemoteShell({ host: "h", connectTimeoutSeconds: 5 }, fake.runner, 1_000));
const wordsOf = (call: RecordedCall | undefined): string[] => shellWords(withoutKitDir(call?.script ?? "", DIR) ?? "");

describe("CKB addresses", () => {
  const secp = lockOf("0xb39bbc0b3673c7d36450bc14cfcdad2d559c6c64");

  it("encodes the RFC 0021 full-format vectors (testnet and mainnet, hash types type and data1)", () => {
    assert.equal(ckbAddress(secp, "testnet"), "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqdnnw7qkdnnclfkg59uzn8umtfd2kwxceqgutnjd");
    assert.equal(ckbAddress(secp, "mainnet"), "ckb1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqdnnw7qkdnnclfkg59uzn8umtfd2kwxceqxwquc4");
    assert.equal(ckbAddress({ ...secp, hash_type: "data1" }, "testnet"), "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq4nnw7qkdnnclfkg59uzn8umtfd2kwxceqkkxdwn");
  });

  it("matches CCC for a script with empty args and hash type data", () => {
    const funding = { code_hash: "0x6c67887fe201ee0c7853f1682c0b77c0e6214044c156c7558269390a8afa6d7c", hash_type: "data", args: "0x" };
    assert.equal(ckbAddress(funding, "testnet"), "ckt1qpkx0zrlugq7urrc20ckstqtwlqwvg2qgnq4d364sf5njz52lfkhcqqnm74th");
  });

  it("encodes the BIP 350 bech32m test vectors", () => {
    assert.equal(encodeBech32m("a", new Uint8Array()), "a1lqfn3a");
    const groups = Array.from({ length: 32 }, (_, index) => 31 - index);
    let bits = 0n;
    for (const group of groups) bits = (bits << 5n) | BigInt(group);
    const bytes = Buffer.from(bits.toString(16).padStart(40, "0"), "hex");
    assert.equal(encodeBech32m("abcdef", bytes), "abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx");
  });

  it("refuses an unknown hash type", () => {
    assert.throws(() => ckbAddress({ ...secp, hash_type: "data9" }, "testnet"), /Unknown CKB script hash type/);
  });
});

describe("LndCli", () => {
  const lnd = (answer: (args: string[]) => ReturnType<typeof result> = () => result("{}")) => {
    const fake = new FakeRunner((call) => answer(wordsOf(call).slice(6)));
    return { node: new LndCli("lnd-hub", kitOf(fake)), fake };
  };
  const argsOf = (fake: FakeRunner, index = 0): string[] => wordsOf(fake.calls[index]).slice(4);

  it("runs lncli on signet inside its own container", async () => {
    const { node, fake } = lnd(() => result('{"identity_pubkey":"02aa"}'));
    await node.info();
    assert.deepEqual(wordsOf(fake.calls[0]), ["docker", "compose", "exec", "-T", "lnd-hub", "lncli", "--network=signet", "getinfo"]);
  });

  it("reports the wallet state, and null while LND's RPC is down", async () => {
    assert.equal(await lnd(() => result('{"state":"NON_EXISTING"}')).node.state(), "NON_EXISTING");
    assert.equal(await lnd(() => result("", 1, "connection refused")).node.state(), null);
  });

  it("opens channels, sends coins and makes p2tr addresses with exact amounts", async () => {
    const { node, fake } = lnd((args) => result(JSON.stringify({ funding_txid: "f1", txid: "t1", address: "tb1p1" })));
    assert.equal(await node.openChannel("02bb", 600_000n), "f1");
    assert.equal(await node.sendCoins("tb1pdemo", 200_000n), "t1");
    assert.equal(await node.newAddress(), "tb1p1");
    assert.deepEqual(argsOf(fake, 0), ["lnd-hub", "lncli", "--network=signet", "openchannel", "--node_key=02bb", "--local_amt=600000"]);
    assert.deepEqual(argsOf(fake, 1), ["lnd-hub", "lncli", "--network=signet", "sendcoins", "--addr=tb1pdemo", "--amt=200000"]);
    assert.deepEqual(argsOf(fake, 2), ["lnd-hub", "lncli", "--network=signet", "newaddress", "p2tr"]);
  });

  it("opens a private channel with sats pushed to the peer when asked, and adds no flag for a zero push", async () => {
    const { node, fake } = lnd(() => result(JSON.stringify({ funding_txid: "f1" })));
    assert.equal(await node.openChannel("02bb", 220_000n, { pushSats: 100_000n, private: true }), "f1");
    await node.openChannel("02bb", 220_000n, { pushSats: 0n, private: false });
    const openchannel = ["lnd-hub", "lncli", "--network=signet", "openchannel", "--node_key=02bb", "--local_amt=220000"];
    assert.deepEqual(argsOf(fake, 0), [...openchannel, "--push_amt=100000", "--private"]);
    assert.deepEqual(argsOf(fake, 1), openchannel);
  });

  it("treats `already connected` as success and rethrows any other connect error", async () => {
    await lnd(() => result("", 1, "[lncli] rpc error: code = Unknown desc = already connected to peer: 02aa@1.2.3.4:9735")).node.connect("02aa", "1.2.3.4:9735");
    await assert.rejects(lnd(() => result("", 1, "dial tcp: i/o timeout")).node.connect("02aa", "1.2.3.4:9735"), /i\/o timeout/);
  });

  it("pays without a prompt, with a fee limit and a timeout, and gives the remote call its own time budget", async () => {
    const { node, fake } = lnd(() => result('{"status":"SUCCEEDED","payment_preimage":"aa","payment_hash":"bb","failure_reason":"FAILURE_REASON_NONE","fee_sat":"0"}'));
    const payment = await node.payInvoice("lntbs1...", { feeLimitSats: 100n, timeoutSeconds: 120, callTimeoutMs: 600_000 });
    assert.equal(payment.status, "SUCCEEDED");
    assert.deepEqual(argsOf(fake).slice(3), ["payinvoice", "--force", "--json", "--fee_limit=100", "--timeout=120s", "lntbs1..."]);
    assert.equal(fake.calls[0]?.options.timeoutMs, 600_000);
  });

  it("bakes a macaroon into the node's data folder", async () => {
    const { node, fake } = lnd(() => result(""));
    assert.equal(await node.bakeMacaroon("hub.macaroon", ["info:read", "invoices:write"]), "/root/.lnd/hub.macaroon");
    assert.deepEqual(argsOf(fake).slice(3), ["bakemacaroon", "--save_to=/root/.lnd/hub.macaroon", "info:read", "invoices:write"]);
  });

  it("sums the balances of the channels with one peer", () => {
    const channels = [lndChannel("02aa", 100n, 50n), lndChannel("02aa", 10n, 5n, false), lndChannel("02bb", 999n, 999n)];
    assert.deepEqual(balancesWith(channels, "02aa"), { local: 110n, remote: 55n, active: 1 });
    assert.deepEqual(balancesWith(channels, "02cc"), { local: 0n, remote: 0n, active: 0 });
  });
});

describe("FiberRpc", () => {
  const fnn = (answer: (request: { method: string; params: unknown[] }) => unknown) => {
    const fake = new FakeRunner((call) => {
      const request = JSON.parse(call.input) as { id: number; method: string; params: unknown[] };
      const value = answer(request);
      return result(JSON.stringify(value instanceof Error ? { jsonrpc: "2.0", id: request.id, error: { code: -1, message: value.message } } : { jsonrpc: "2.0", id: request.id, result: value }));
    });
    return { node: new FiberRpc("fnn-hub", kitOf(fake)), fake };
  };

  it("posts JSON-RPC on stdin to the node's own RPC, from inside its container (no RPC port on the host)", async () => {
    const { node, fake } = fnn(() => ({ peers: [] }));
    await node.peers();
    const words = wordsOf(fake.calls[0]);
    assert.deepEqual(words.slice(0, 7), ["docker", "compose", "exec", "-T", "fnn-hub", "sh", "-c"]);
    assert.match(words[7] ?? "", /curl -sS -m \d+ .*--data-binary @- "http:\/\/\$RPC_LISTENING_ADDR"/);
    assert.deepEqual(JSON.parse(fake.calls[0]?.input ?? ""), { jsonrpc: "2.0", id: 1, method: "list_peers", params: [] });
  });

  it("turns a JSON-RPC error into FiberRpcError with fnn's own text", async () => {
    const { node } = fnn(() => new Error("Invalid parameter: insufficient balance"));
    await assert.rejects(node.openChannel("02aa", 1n, null), (error: unknown) => {
      assert.ok(error instanceof FiberRpcError);
      assert.equal(error.rpcMessage, "Invalid parameter: insufficient balance");
      assert.equal(error.message, "fnn-hub open_channel: Invalid parameter: insufficient balance");
      return true;
    });
  });

  it("names the method when the answer is not JSON-RPC", async () => {
    const fake = new FakeRunner(() => result("curl: (7) Failed to connect"));
    await assert.rejects(new FiberRpc("fnn-demo", kitOf(fake)).nodeInfo(), /fnn-demo node_info: not a JSON-RPC answer: curl: \(7\)/);
  });

  it("opens public channels with the exact amount in hex, and a UDT type script for RUSD", async () => {
    const { node, fake } = fnn(() => ({ temporary_channel_id: "0x77" }));
    assert.equal(await node.openChannel("02aa", 100_000_000_000n, null), "0x77");
    await node.openChannel("02aa", 10_000_000_000n, TESTNET_RUSD_TYPE_SCRIPT);
    const params = fake.calls.map((call) => (JSON.parse(call.input) as { params: unknown[] }).params[0]);
    assert.deepEqual(params[0], { pubkey: "02aa", funding_amount: "0x174876e800", public: true });
    assert.deepEqual(params[1], { pubkey: "02aa", funding_amount: "0x2540be400", public: true, funding_udt_type_script: toFnnScript(TESTNET_RUSD_TYPE_SCRIPT) });
  });

  it("makes testnet sha256 invoices for a preimage the caller made", async () => {
    const { node, fake } = fnn(() => ({ invoice_address: "fibt1abc" }));
    const preimage = "11".repeat(32);
    const invoice = await node.newInvoice({
      amount: 1_234_500_000n,
      udtTypeScript: null,
      preimage,
      expirySeconds: 3_600,
      finalExpiryDeltaMs: FIBER_MIN_FINAL_EXPIRY_DELTA_MS,
      description: "test",
    });
    assert.equal(invoice, "fibt1abc");
    const [params] = (JSON.parse(fake.calls[0]?.input ?? "") as { params: unknown[] }).params;
    assert.deepEqual(params, {
      amount: `0x${(1_234_500_000).toString(16)}`,
      currency: "Fibt",
      description: "test",
      hash_algorithm: "sha256",
      payment_preimage: `0x${preimage}`,
      expiry: "0xe10",
      final_expiry_delta: `0x${(160 * 60 * 1000).toString(16)}`,
    });
  });

  it("lists channels with one peer, or all", async () => {
    const { node, fake } = fnn(() => ({ channels: [] }));
    await node.channels("02aa");
    await node.channels();
    assert.deepEqual(fake.calls.map((call) => (JSON.parse(call.input) as { params: unknown[] }).params), [[{ pubkey: "02aa" }], [{}]]);
  });

  it("connects peers so they are saved for restarts", async () => {
    const { node, fake } = fnn(() => null);
    await node.connectPeer("/dns4/bottle.fiber.channel/tcp/8119/p2p/QmX");
    assert.deepEqual((JSON.parse(fake.calls[0]?.input ?? "") as { params: unknown[] }).params, [{ address: "/dns4/bottle.fiber.channel/tcp/8119/p2p/QmX", save: true }]);
  });

  it("tells channels of each asset apart", () => {
    const rusd = toFnnScript(TESTNET_RUSD_TYPE_SCRIPT);
    assert.equal(isChannelOfAsset(fnnChannel("02aa", 1n, 1n), null), true);
    assert.equal(isChannelOfAsset(fnnChannel("02aa", 1n, 1n, { udt: rusd }), null), false);
    assert.equal(isChannelOfAsset(fnnChannel("02aa", 1n, 1n, { udt: rusd }), TESTNET_RUSD_TYPE_SCRIPT), true);
    assert.equal(isChannelOfAsset(fnnChannel("02aa", 1n, 1n, { udt: { ...rusd, args: "0x00" } }), TESTNET_RUSD_TYPE_SCRIPT), false);
  });
});

describe("multiaddrs", () => {
  it("reads the peer id and the host", () => {
    assert.equal(peerIdOf("/ip4/203.0.113.7/tcp/8228/ws/p2p/QmA"), "QmA");
    assert.equal(peerIdOf("/ip4/203.0.113.7/tcp/8228"), null);
    assert.equal(peerIdOf("/ip4/1.2.3.4/tcp/1/p2p/"), null);
    assert.equal(hostOfMultiaddr("/dns4/bottle.fiber.channel/tcp/8119/p2p/QmX"), "bottle.fiber.channel");
    assert.equal(hostOfMultiaddr("/ip4/203.0.113.7/tcp/8228"), "203.0.113.7");
    assert.equal(hostOfMultiaddr("/tcp/8228"), null);
  });

  it("finds the peer id fnn announces with any address, public or Docker-only", () => {
    const info = (addresses: string[]): FnnNodeInfo => ({ version: "", pubkey: "", addresses, chain_hash: "", default_funding_lock_script: lockOf("0x") });
    assert.equal(announcedPeerId(info(["/ip4/203.0.113.7/tcp/8228/p2p/QmHub", "/ip4/203.0.113.7/tcp/8228/ws/p2p/QmHub"])), "QmHub");
    assert.equal(announcedPeerId(info(["/dns4/fnn-hub/tcp/8228/p2p/QmHub"])), "QmHub");
    assert.equal(announcedPeerId(info([])), null);
  });

  it("dials a node on the Docker network by its service name", () => {
    assert.equal(dockerNetworkMultiaddr("fnn-hub", 8228, "QmHub"), "/dns4/fnn-hub/tcp/8228/p2p/QmHub");
  });
});

describe("HubApi (curl on the server)", () => {
  it("splits curl's body from the status line", () => {
    assert.deepEqual(parseCurlResponse('{"a":1}\n200'), { status: 200, body: { a: 1 } });
    assert.deepEqual(parseCurlResponse('{\n"a": 1\n}\n201'), { status: 201, body: { a: 1 } });
    assert.deepEqual(parseCurlResponse("\n204"), { status: 204, body: null });
    assert.deepEqual(parseCurlResponse("<html>\n502"), { status: 502, body: null });
    assert.deepEqual(parseCurlResponse("garbage"), { status: 0, body: null });
  });

  it("finds the hub's port from Compose, so it follows HUB_HOST_PORT", async () => {
    const fake = new FakeRunner(() => result("127.0.0.1:18787\n"));
    const hub = await HubApi.connect(kitOf(fake), 30);
    assert.equal(hub.baseUrl, "http://127.0.0.1:18787");
    assert.equal(withoutKitDir(fake.calls[0]?.script ?? "", DIR), "docker compose port hub 8787");
    await assert.rejects(HubApi.connect(kitOf(new FakeRunner(() => result(":0\n"))), 30), /publishes no port/);
  });

  it("sends JSON bodies on stdin, never on the command line, and reads the status code", async () => {
    const fake = new FakeRunner(() => result('{"id":"q1"}\n201'));
    const hub = new HubApi(kitOf(fake), "http://127.0.0.1:18787", 30);
    const quote = await hub.createQuote({ direction: "ln_to_fiber", asset: "CKB", side: "pay", amount: "2000" });
    assert.deepEqual(quote, { id: "q1" });
    const words = wordsOf(fake.calls[0]);
    assert.deepEqual(words, [
      "curl", "-sS", "-m", "30", "-X", "POST", "-H", "accept: application/json", "-H", "content-type: application/json",
      "--data-binary", "@-", "-w", "\n%{http_code}", "http://127.0.0.1:18787/v1/quotes",
    ]);
    assert.deepEqual(JSON.parse(fake.calls[0]?.input ?? ""), { direction: "ln_to_fiber", asset: "CKB", side: "pay", amount: "2000" });
  });

  it("throws HubApiError with the hub's error code and sentence", async () => {
    const fake = new FakeRunner(() => result('{"error":{"code":"liquidity_unavailable","message":"Not enough liquidity."}}\n422'));
    const hub = new HubApi(kitOf(fake), "http://127.0.0.1:18787", 30);
    await assert.rejects(hub.createSwap({ quoteId: "q", payoutInvoice: "fibt1" }), (error: unknown) => {
      assert.ok(error instanceof HubApiError);
      assert.equal(error.status, 422);
      assert.equal(error.code, "liquidity_unavailable");
      assert.match(error.message, /hub answered 422 liquidity_unavailable: Not enough liquidity\./);
      return true;
    });
  });

  it("reads health on 200 and on 503 (degraded), lists assets, events, and treats a missing /v1/fiber/node as null", async () => {
    const answers: Record<string, string> = {
      "/v1/health": '{"status":"degraded","reason":"LND is not synced."}\n503',
      "/v1/assets": '{"data":[{"id":"CKB"}]}\n200',
      "/v1/fiber/node": '{"error":{"code":"not_found","message":"x"}}\n404',
      "/v1/swaps/s1/events": '{"data":[{"type":"created"}]}\n200',
    };
    const fake = new FakeRunner((call) => result(answers[new URL(wordsOf(call).at(-1) ?? "").pathname] ?? "\n500"));
    const hub = new HubApi(kitOf(fake), "http://127.0.0.1:18787", 30);
    const health = await hub.health();
    assert.equal(health.status, 503);
    assert.equal(health.health?.status, "degraded");
    assert.deepEqual(await hub.assets(), [{ id: "CKB" }]);
    assert.equal(await hub.fiberNode(), null);
    assert.deepEqual(await hub.swapEvents("s1"), [{ type: "created" }]);
    assert.ok(fake.calls.every((call) => wordsOf(call)[5] === "GET"), "reads are GETs");
  });
});

describe("faucets and the CKB RPC (HTTP from this machine)", () => {
  it("asks the Mutinynet faucet for an invoice of the exact amount, without any login", async () => {
    const http = new FakeHttp().on((request) => (request.url.endsWith("/api/bolt11") ? json(200, { bolt11: "lntbs20u1..." }) : undefined));
    const faucet = new MutinynetFaucet(http.client, "https://faucet.mutinynet.com", 5_000);
    assert.equal(await faucet.invoice(2_000n), "lntbs20u1...");
    assert.deepEqual(http.requests[0], { method: "POST", url: "https://faucet.mutinynet.com/api/bolt11", json: { amount_sats: 2000 }, timeoutMs: 5_000 });
  });

  it("fails clearly when the faucet refuses or answers without bolt11", async () => {
    const limited = new MutinynetFaucet(new FakeHttp().on(() => ({ status: 429, text: "Too many requests" })).client, "https://f", 1);
    await assert.rejects(limited.invoice(1n), /HTTP 429 Too many requests/);
    const odd = new MutinynetFaucet(new FakeHttp().on(() => json(200, { invoice: "x" })).client, "https://f", 1);
    await assert.rejects(odd.invoice(1n), /has no bolt11/);
    const html = new MutinynetFaucet(new FakeHttp().on(() => ({ status: 200, text: "<html>" })).client, "https://f", 1);
    await assert.rejects(html.invoice(1n), /not JSON/);
  });

  it("claims testnet CKB for an address with the faucet's body shape, and reads its claims with GET", async () => {
    const http = new FakeHttp().on(() => json(201, { ok: true }));
    const faucet = new CkbFaucet(http.client, "https://faucet-api.nervos.org", 5_000);
    await faucet.claim("ckt1qabc", "100000");
    await faucet.claims("ckt1qabc");
    assert.deepEqual(http.requests[0]?.json, { claim_event: { address_hash: "ckt1qabc", amount: "100000" } });
    assert.equal(http.requests[0]?.url, "https://faucet-api.nervos.org/claim_events");
    assert.equal(http.requests[1]?.method, "GET");
    assert.equal(http.requests[1]?.url, "https://faucet-api.nervos.org/claim_events?address_hash=ckt1qabc");
  });

  it("reads an fnn wallet's CKB with the indexer's get_cells_capacity (exact lock)", async () => {
    const lock = lockOf("0x1111");
    const http = new FakeHttp().on(() => json(200, { jsonrpc: "2.0", id: 1, result: { capacity: "0x2540be400", block_hash: "0x", block_number: "0x1" } }));
    const rpc = new CkbRpc(http.client, "https://testnet.ckbapp.dev/", 5_000);
    assert.equal(await rpc.capacityOf(lock), 10_000_000_000n);
    assert.deepEqual(http.requests[0]?.json, {
      jsonrpc: "2.0",
      id: 1,
      method: "get_cells_capacity",
      params: [{ script: lock, script_type: "lock", script_search_mode: "exact" }],
    });
    const empty = new CkbRpc(new FakeHttp().on(() => json(200, { jsonrpc: "2.0", id: 1, result: null })).client, "https://x/", 1);
    assert.equal(await empty.capacityOf(lock), 0n);
    const broken = new CkbRpc(new FakeHttp().on(() => json(200, { jsonrpc: "2.0", id: 1, error: { message: "indexer off" } })).client, "https://x/", 1);
    await assert.rejects(broken.capacityOf(lock), /indexer off/);
  });
});

describe("waitFor", () => {
  it("returns the first value, polling on the given interval", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const value = await waitFor("x", async () => (++calls === 3 ? "ready" : undefined), { timeoutMs: 100, intervalMs: 10, clock });
    assert.equal(value, "ready");
    assert.deepEqual(clock.sleeps, [10, 10]);
  });

  it("times out with what it waited for and the last error when errors are retried", async () => {
    const clock = new FakeClock();
    await assert.rejects(
      waitFor("lnd-hub to answer", async () => {
        throw new Error("connection refused");
      }, { timeoutMs: 30_000, intervalMs: 10_000, retryErrors: true, clock }),
      /Timed out after 30 s waiting for lnd-hub to answer \(last error: connection refused\)/,
    );
  });

  it("fails at once on an error when errors are not retried", async () => {
    const clock = new FakeClock();
    await assert.rejects(waitFor("x", async () => Promise.reject(new Error("boom")), { timeoutMs: 1_000, intervalMs: 10, clock }), /boom/);
    assert.deepEqual(clock.sleeps, []);
  });
});
