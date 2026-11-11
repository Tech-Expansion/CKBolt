import { expect, test } from "@playwright/test";
import { HUB_PANEL_COPY } from "../../components/app/fiber-node/copy";
import type { FiberAssetId, FiberNodeDto, Script } from "../../lib/hub/contract";
import { ckbToShannons } from "../../lib/wallets/fiber-browser/channels";
import { CHANNEL_FEE_MARGIN_CKB, CHANNEL_RESERVE_CKB, HUB_RUN_TIMING } from "../../lib/wallets/fiber-browser/constants";
import { openOwnTokenChannel } from "../../components/app/fiber-node/channel-actions";
import {
  hubRowAssets,
  hubRows,
  hubRowTone,
  hubRowView,
  hubRunSummary,
  hubRunSummaryTone,
  maxContribution,
  offersFundingChoice,
  rowFunding,
  runHubRequests,
  runRowRequest,
  selectionNeeds,
  waitForFunding,
  FUNDING_STUCK_REASON,
  type FundingWaitResult,
  type HubRowState,
  type HubRunProgress,
  type HubRunRow,
} from "../../lib/wallets/fiber-browser/hub-channel-rows";
import type { BrowserFiberNode, NodeChannel, OpenChannelArgs } from "../../lib/wallets/fiber-browser/node-port";
import { checkOwnAmount, maxOwnAmount, ownAmountText, ownChannelPlan, ownTokenOffer, OWN_OFFER_MESSAGE, OWN_TOKEN_MESSAGE } from "../../lib/wallets/fiber-browser/own-token-channel";
import { peerIdOf } from "../../lib/wallets/fiber-browser/peer-id";

/*
 * "Channel with the hub" as one card (docs/fiber-wallet-popup.md, "Channel with the hub: one card"): its rows built from
 * the hub's GET /v1/fiber/node alone, where each stands, what the ticked rows need on chain, the run that asks for them
 * one after another (a failed row does not stop the next; each waits for the last funding), and its copy.
 */

const HUB_NODE_ID = "02b6d4e3ab86a2ca2fad6fae0ecb2e1e559e0b911939872a90abdda6d20302be71";
const OTHER_NODE_ID = `03${"cd".repeat(32)}`;
const RUSD: Script = { codeHash: `0x${"11".repeat(32)}`, hashType: "type", args: `0x${"87".repeat(32)}` };
const CWBTC: Script = { codeHash: `0x${"25".repeat(32)}`, hashType: "type", args: `0x${"9a".repeat(36)}` };
const NEWT: Script = { codeHash: `0x${"42".repeat(32)}`, hashType: "type", args: `0x${"aa".repeat(32)}` };

const hubNode = (patch: Partial<FiberNodeDto["inbound"]> = {}): FiberNodeDto => ({
  nodeId: HUB_NODE_ID,
  network: "testnet",
  addresses: { p2p: [], ws: [] },
  // The hub's own order, CKB not first, as a hub may list it.
  assets: [
    { id: "RUSD", udtTypeScript: RUSD, udtWhitelist: null, peerChannels: null },
    { id: "CKB", udtTypeScript: null, udtWhitelist: null, peerChannels: null },
    { id: "CWBTC", udtTypeScript: CWBTC, udtWhitelist: null, peerChannels: null },
  ],
  inbound: { enabled: true, amounts: { CKB: "100000000000", RUSD: "1000000000", CWBTC: "10000000" }, ...patch },
});

let nextId = 0;
const channel = (o: { udt?: Script | null; state?: string; local?: bigint; remote?: bigint; peer?: string }): NodeChannel => ({
  channelId: `0x${(nextId++).toString(16).padStart(64, "0")}`,
  peerId: o.peer ?? HUB_NODE_ID,
  udtTypeScript: o.udt ?? null,
  state: o.state ?? "ChannelReady",
  isPublic: false,
  enabled: true,
  localBalance: o.local ?? BigInt(0),
  remoteBalance: o.remote ?? BigInt(0),
});

const kinds = (rows: { asset: FiberAssetId; state: HubRowState }[]) => Object.fromEntries(rows.map((r) => [r.asset, r.state.kind]));

/* -------------------------------------------------------------------------------------------- the rows */

test.describe("hub channel rows: built from the hub's assets", () => {
  test("CKB first, then the hub's tokens in its order, only those it funds; a new asset is a new row with no change here", () => {
    expect(hubRowAssets(hubNode())).toEqual(["CKB", "RUSD", "CWBTC"]);
    // A token the hub lists but funds no inbound channel in is not offered.
    expect(hubRowAssets(hubNode({ amounts: { CKB: "100000000000", RUSD: "1000000000" } }))).toEqual(["CKB", "RUSD"]);
    expect(hubRowAssets(hubNode({ enabled: false }))).toEqual([]);
    const withNew = hubNode({ amounts: { CKB: "1", RUSD: "1", CWBTC: "1", NEWT: "5" } });
    withNew.assets.push({ id: "NEWT", udtTypeScript: NEWT, udtWhitelist: null, peerChannels: null });
    expect(hubRowAssets(withNew)).toEqual(["CKB", "RUSD", "CWBTC", "NEWT"]);
    expect(hubRows(withNew, [], []).map((r) => [r.asset, r.hubAmount, r.state.kind])).toEqual([
      ["CKB", BigInt(1), "available"],
      ["RUSD", BigInt(1), "available"],
      ["CWBTC", BigInt(1), "available"],
      ["NEWT", BigInt(5), "available"],
    ]);
  });

  test("where each row stands: open, opening, restart, the hub cannot fund, or not open", () => {
    const node = hubNode({ fundable: { CKB: true, RUSD: false, CWBTC: false } });
    // Nothing yet: CKB can be asked for; the hub says it cannot fund RUSD or cWBTC now.
    expect(kinds(hubRows(node, [], []))).toEqual({ CKB: "available", RUSD: "unfundable", CWBTC: "unfundable" });
    // A token with a channel is Open, never "cannot fund", whatever the hub says about a new one.
    const rows = hubRows(
      node,
      [
        channel({ local: ckbToShannons(19_901), remote: ckbToShannons(2_901) }),
        channel({ udt: RUSD, local: BigInt(0), remote: BigInt(1_000_000_000) }),
        // A channel with another node in cWBTC does not count; the hub's own does.
        channel({ udt: CWBTC, peer: OTHER_NODE_ID }),
      ],
      [],
    );
    expect(kinds(rows)).toEqual({ CKB: "open", RUSD: "open", CWBTC: "unfundable" });
    expect(rows[0].state).toEqual({ kind: "open", liquidity: { send: ckbToShannons(19_901), receive: ckbToShannons(2_901) } });
    // Funding not confirmed yet: opening. Closing or closed: as if none (a new one may be asked for).
    expect(kinds(hubRows(hubNode(), [channel({ state: "AwaitingChannelReady" }), channel({ udt: RUSD, state: "ShuttingDown" }), channel({ udt: CWBTC, state: "Closed" })], [])))
      .toEqual({ CKB: "opening", RUSD: "available", CWBTC: "available" });
    // A token the node started without asks for a restart, unless it has a channel already; the restart wins over "cannot fund".
    expect(kinds(hubRows(node, [channel({ udt: RUSD })], ["RUSD", "CWBTC"]))).toEqual({ CKB: "available", RUSD: "open", CWBTC: "restart" });
  });
});

/* ------------------------------------------------------------------------------------------- selection */

test.describe("hub channel rows: what the ticked rows need on chain", () => {
  const token = CHANNEL_RESERVE_CKB.UDT + CHANNEL_FEE_MARGIN_CKB;

  test("the CKB put in plus the fee margin, and 181 CKB per token channel; what the node holds; what is missing, rounded up", () => {
    expect(token).toBe(181);
    expect(selectionNeeds(["CKB"], 20_000, ckbToShannons(20_001))).toEqual({ neededCkb: 20_001, haveCkb: 20_001, enough: true, shortCkb: 0 });
    // A real case: 20,000 CKB put in, RUSD and cWBTC too.
    expect(selectionNeeds(["CKB", "RUSD", "CWBTC"], 20_000, ckbToShannons(20_100))).toEqual({ neededCkb: 20_363, haveCkb: 20_100, enough: false, shortCkb: 263 });
    // Tokens only: the CKB field does not count.
    expect(selectionNeeds(["RUSD", "CWBTC"], 49_000, ckbToShannons(600))).toEqual({ neededCkb: 362, haveCkb: 600, enough: true, shortCkb: 0 });
    // Part of a CKB: "you have" rounds down, "add" rounds up.
    expect(selectionNeeds(["RUSD"], 0, ckbToShannons(180) + BigInt(50_000_000))).toEqual({ neededCkb: 181, haveCkb: 180, enough: false, shortCkb: 1 });
    // Balance not read yet: never enough, nothing missing to say.
    expect(selectionNeeds(["CKB"], 1_200, null)).toEqual({ neededCkb: 1_201, haveCkb: null, enough: false, shortCkb: 0 });
    expect(selectionNeeds([], 1_200, ckbToShannons(5))).toMatchObject({ neededCkb: 0, enough: true });
  });

  test("Max: all the node holds but the fee margin, less what the ticked token rows need", () => {
    expect(maxContribution(ckbToShannons(20_363), [])).toBe(20_362);
    expect(maxContribution(ckbToShannons(20_363), ["CKB"])).toBe(20_362);
    expect(maxContribution(ckbToShannons(20_363), ["CKB", "RUSD", "CWBTC"])).toBe(20_000);
    // The total then fits exactly.
    expect(selectionNeeds(["CKB", "RUSD", "CWBTC"], 20_000, ckbToShannons(20_363)).enough).toBe(true);
    expect(maxContribution(ckbToShannons(100), ["RUSD"])).toBe(0);
  });
});

/* ------------------------------------------------------------------------------------------------- run */

interface Trace {
  events: string[];
  rows: Record<string, (HubRunRow | null)[]>;
  progress: (HubRunProgress | null)[];
}

function harness(o: { fail?: Record<string, string>; stopAfter?: string; waits?: Record<string, FundingWaitResult> } = {}) {
  const trace: Trace = { events: [], rows: {}, progress: [] };
  let stop = false;
  const deps = {
    request: async (asset: FiberAssetId) => {
      trace.events.push(`ask ${asset}`);
      if (o.fail?.[asset]) throw new Error(o.fail[asset]);
      if (o.stopAfter === asset) stop = true;
      return { asset };
    },
    waitForFunding: async (asset: FiberAssetId, failed: boolean) => {
      trace.events.push(failed ? `wait ${asset} after failure` : `wait ${asset}`);
      return o.waits?.[asset] ?? "funded";
    },
    onRow: (asset: FiberAssetId, row: HubRunRow | null) => {
      (trace.rows[asset] ??= []).push(row);
    },
    onProgress: (p: HubRunProgress | null) => void trace.progress.push(p),
    stopped: () => stop,
  };
  return { trace, deps };
}

test.describe("hub channel rows: the run", () => {
  test("asks for the rows in order, one after another, and waits for each funding before the next (not after the last)", async () => {
    const { trace, deps } = harness();
    const outcome = await runHubRequests(["CKB", "RUSD", "CWBTC"], deps);
    expect(trace.events).toEqual(["ask CKB", "wait CKB", "ask RUSD", "wait RUSD", "ask CWBTC"]);
    expect(outcome).toEqual({ done: ["CKB", "RUSD", "CWBTC"], failed: [], skipped: [] });
    expect(trace.rows.RUSD).toEqual([{ status: "queued" }, { status: "asking" }, { status: "done" }]);
    expect(trace.progress).toEqual([
      { kind: "asking", asset: "CKB", index: 1, total: 3 },
      { kind: "waiting", asset: "CKB" },
      { kind: "asking", asset: "RUSD", index: 2, total: 3 },
      { kind: "waiting", asset: "RUSD" },
      { kind: "asking", asset: "CWBTC", index: 3, total: 3 },
      null,
    ]);
    expect(hubRunSummary(outcome)).toEqual({ kind: "all_done", done: 3 });
  });

  test("a failed row does not stop the next ones; it says why, and only a funding still pending is waited for after it", async () => {
    const { trace, deps } = harness({ fail: { RUSD: "Your node already has a RUSD channel from the hub, open or opening." } });
    const outcome = await runHubRequests(["CKB", "RUSD", "CWBTC"], deps);
    // A request can fail after the hub or fnn acted on it: the next waits while a channel is still being funded.
    expect(trace.events).toEqual(["ask CKB", "wait CKB", "ask RUSD", "wait RUSD after failure", "ask CWBTC"]);
    // No "waiting for the RUSD channel" line for a channel that was not asked for.
    expect(trace.progress).not.toContainEqual({ kind: "waiting", asset: "RUSD" });
    expect(outcome).toEqual({ done: ["CKB", "CWBTC"], failed: ["RUSD"], skipped: [] });
    expect(trace.rows.RUSD.at(-1)).toEqual({ status: "failed", reason: "Your node already has a RUSD channel from the hub, open or opening." });
    expect(hubRunSummary(outcome)).toEqual({ kind: "some_failed", done: 2, total: 3, failed: 1 });
    // fnn's own words, without its RPC wrapper.
    const fnn = harness({ fail: { CKB: 'ErrorObject { code: ServerError(-32000), message: "insufficient capacity" }' } });
    await runHubRequests(["CKB"], fnn.deps);
    expect(fnn.trace.rows.CKB.at(-1)).toEqual({ status: "failed", reason: "insufficient capacity" });
    expect(hubRunSummary({ done: [], failed: ["CKB"], skipped: [] })).toEqual({ kind: "none_done", total: 1 });
  });

  test("a funding still pending after the longest wait stops the run: the rows not asked fail with that reason", async () => {
    const { trace, deps } = harness({ waits: { CKB: "timeout" } });
    const outcome = await runHubRequests(["CKB", "RUSD", "CWBTC"], deps);
    // fnn keeps the pending funding's cells: the next open would fail, or the hub would open one the node cannot accept.
    expect(trace.events).toEqual(["ask CKB", "wait CKB"]);
    expect(outcome).toEqual({ done: ["CKB"], failed: ["RUSD", "CWBTC"], skipped: [] });
    expect(trace.rows.RUSD).toEqual([{ status: "queued" }, { status: "failed", reason: FUNDING_STUCK_REASON }]);
    expect(trace.rows.CWBTC.at(-1)).toEqual({ status: "failed", reason: FUNDING_STUCK_REASON });
    expect(trace.progress.at(-1)).toBeNull();
    expect(hubRunSummary(outcome)).toEqual({ kind: "some_failed", done: 1, total: 3, failed: 2 });
    // The same after a failed row whose funding is still pending; a failed row can be ticked again.
    const afterFailure = harness({ fail: { CKB: "accept_channel timed out" }, waits: { CKB: "timeout" } });
    expect(await runHubRequests(["CKB", "RUSD"], afterFailure.deps)).toEqual({ done: [], failed: ["CKB", "RUSD"], skipped: [] });
    expect(afterFailure.trace.events).toEqual(["ask CKB", "wait CKB after failure"]);
    expect(hubRowView({ kind: "available" }, { status: "failed", reason: FUNDING_STUCK_REASON }).selectable).toBe(true);
    for (const sentence of FUNDING_STUCK_REASON.split(/(?<=[.!?])\s+/)) expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(12);
  });

  test("stopping asks for nothing more: the row under way finishes, the rest go back to how they were", async () => {
    const { trace, deps } = harness({ stopAfter: "CKB" });
    const outcome = await runHubRequests(["CKB", "RUSD", "CWBTC"], deps);
    expect(trace.events).toEqual(["ask CKB"]);
    expect(outcome).toEqual({ done: ["CKB"], failed: [], skipped: ["RUSD", "CWBTC"] });
    expect(trace.rows.RUSD).toEqual([{ status: "queued" }, null]);
    expect(trace.progress.at(-1)).toBeNull();
    expect(hubRunSummary(outcome)).toEqual({ kind: "stopped", done: 1, total: 3 });
  });

  test("waiting for a funding: until the new channel shows and nothing is being funded, bounded, retried on a failed read", async () => {
    const timing = { pollMs: 1_000, appearMs: 5_000, waitMs: 20_000 };
    const run = async (answers: (readonly NodeChannel[] | Error)[], stopAt = Infinity) => {
      let now = 0;
      let reads = 0;
      const result = await waitForFunding(
        "RUSD",
        {
          listChannels: async () => {
            const answer = answers[Math.min(reads++, answers.length - 1)];
            if (answer instanceof Error) throw answer;
            return answer;
          },
          hubNode: hubNode(),
          sleep: async (ms) => void (now += ms),
          now: () => now,
          stopped: () => now >= stopAt,
        },
        timing,
      );
      return { result, reads, waited: now };
    };
    const ckbFunding = channel({ state: "CollaboratingFundingTx" });
    const ckbAwaiting = channel({ state: "AwaitingChannelReady" });
    const ckbReady = channel({});
    const rusdNegotiating = channel({ udt: RUSD, state: "NegotiatingFunding" });
    const rusdReady = channel({ udt: RUSD });
    // The token's channel reaches the node a moment late, then funds, then is ready; the CKB one funded meanwhile.
    expect(await run([[ckbFunding], new Error("node busy"), [ckbAwaiting, rusdNegotiating], [ckbReady, rusdNegotiating], [ckbReady, rusdReady]])).toEqual({
      result: "funded",
      reads: 5,
      waited: 4_000,
    });
    // A channel that never shows (fnn refused it): the wait ends once it had its time to appear, if nothing else funds.
    expect(await run([[ckbReady]])).toEqual({ result: "funded", reads: 6, waited: 5_000 });
    // A channel stuck in funding: the wait gives up after the longest wait (the run then asks for nothing more).
    expect(await run([[ckbReady, rusdNegotiating]])).toMatchObject({ result: "timeout", waited: 20_000 });
    // Stopped: no more waiting.
    expect(await run([[ckbReady, rusdNegotiating]], 3_000)).toMatchObject({ result: "stopped", waited: 3_000 });
    // After a failed row (appearMs 0): nothing to wait for unless a channel is being funded, then until it is.
    const afterFailure = { ...timing, appearMs: 0 };
    const quick = async (answers: (readonly NodeChannel[])[]) => {
      let now = 0;
      let reads = 0;
      const deps = {
        listChannels: async () => answers[Math.min(reads++, answers.length - 1)],
        hubNode: hubNode(),
        sleep: async (ms: number) => void (now += ms),
        now: () => now,
        stopped: () => false,
      };
      return { result: await waitForFunding("RUSD", deps, afterFailure), reads, waited: now };
    };
    expect(await quick([[ckbReady]])).toEqual({ result: "funded", reads: 1, waited: 0 });
    expect(await quick([[ckbReady, rusdNegotiating], [ckbReady, rusdReady]])).toEqual({ result: "funded", reads: 2, waited: 1_000 });
    expect(await quick([[ckbReady, channel({ udt: CWBTC, state: "AwaitingTxSignatures" })]])).toMatchObject({ result: "timeout", waited: 20_000 });
    // The real bounds: a few seconds between reads, about 40 s for fnn's 4 confirmations fits well within the longest wait.
    expect(HUB_RUN_TIMING.pollMs).toBeLessThanOrEqual(5_000);
    expect(HUB_RUN_TIMING.waitMs).toBeGreaterThanOrEqual(120_000);
  });
});

/* --------------------------------------------------------------------------------------------- display */

test.describe("hub channel rows: what a row says, and the copy", () => {
  test("a run's status shows while it is on the row; then the channel's own state; done and failed stay until it shows", () => {
    const available: HubRowState = { kind: "available" };
    const open: HubRowState = { kind: "open", liquidity: { send: BigInt(0), receive: BigInt(0) } };
    expect(hubRowView(available, undefined)).toEqual({ view: "available", selectable: true });
    expect(hubRowView(open, undefined)).toEqual({ view: "open", selectable: false });
    expect(hubRowView({ kind: "unfundable" }, undefined)).toEqual({ view: "unfundable", selectable: false });
    expect(hubRowView({ kind: "restart" }, undefined)).toEqual({ view: "restart", selectable: false });
    expect(hubRowView(available, { status: "queued" })).toEqual({ view: "queued", selectable: false });
    expect(hubRowView({ kind: "opening" }, { status: "asking" })).toEqual({ view: "asking", selectable: false });
    // Asked for, its channel not listed yet: Done, and not to be asked for twice.
    expect(hubRowView(available, { status: "done" })).toEqual({ view: "done", selectable: false });
    expect(hubRowView({ kind: "opening" }, { status: "done" })).toEqual({ view: "opening", selectable: false });
    // Failed: it says so, and may be tried again; a channel that shows after all wins.
    expect(hubRowView(available, { status: "failed", reason: "x" })).toEqual({ view: "failed", selectable: true });
    expect(hubRowView(open, { status: "failed", reason: "x" })).toEqual({ view: "open", selectable: false });
    expect(hubRowTone("open")).toBe("ok");
    expect(hubRowTone("asking")).toBe("pending");
    expect(hubRowTone("failed")).toBe("error");
    expect(hubRowTone("available")).toBe("off");
    expect(hubRunSummaryTone({ kind: "all_done", done: 2 })).toBe("ok");
    expect(hubRunSummaryTone({ kind: "some_failed", done: 1, total: 2, failed: 1 })).toBe("pending");
    expect(hubRunSummaryTone({ kind: "stopped", done: 1, total: 2 })).toBe("pending");
    expect(hubRunSummaryTone({ kind: "none_done", total: 2 })).toBe("error");
  });

  test("the card's lines: the button, the total, the token offer, the summaries, each sentence within 12 words", () => {
    const C = HUB_PANEL_COPY;
    expect(C.OPEN(1)).toBe("Open a channel");
    expect(C.OPEN(3)).toBe("Open 3 channels");
    expect(C.TOTAL("20,363", "20,100")).toBe("Needs 20,363 CKB on chain · you have 20,100 CKB");
    expect(C.SHORT("263")).toBe("Not enough CKB on chain. Add 263 CKB first.");
    expect(C.TOKEN_OFFER("10 RUSD", "181")).toBe("Hub funds 10 RUSD · needs 181 CKB reserve");
    expect(C.SUMMARY.someFailed(2, 3, 1)).toBe("2 of 3 channels asked for. See the failed row.");
    const shown = [
      C.TITLE,
      C.NOT_OFFERED,
      ...Object.values(C.STATUS),
      C.CAPACITY("19,901", "2,901", "CKB"),
      C.READY_SOON,
      C.HUB_FUNDS("1,000 CKB"),
      C.TOKEN_OFFER("0.1 cWBTC", "181"),
      C.PUTS_IN,
      C.MAX,
      C.CONTRIBUTION_ERROR("200"),
      C.TOTAL("20,363", null),
      C.TOTAL("20,363", "20,100"),
      C.SHORT("263"),
      C.OPEN(1),
      C.OPEN(12),
      C.OPENING_NOW,
      C.STOP,
      C.STOP_TITLE,
      C.CHOOSE,
      C.BUSY,
      C.NO_BALANCE,
      C.START_FIRST,
      C.CONNECT_FIRST,
      C.HAS_CHANNEL("cWBTC"),
      C.HUB_SHORT("cWBTC"),
      C.ASKED,
      C.IN_RUN,
      C.PROGRESS_ASKING("cWBTC", 3, 3),
      C.PROGRESS_WAITING("cWBTC"),
      C.SUMMARY.allDone(1),
      C.SUMMARY.allDone(3),
      C.SUMMARY.someFailed(2, 3, 2),
      C.SUMMARY.noneDone(1),
      C.SUMMARY.noneDone(3),
      C.SUMMARY.stopped(1, 3),
      C.RESTART("cWBTC"),
      C.LOCK,
      C.LOCK_BUSY,
    ];
    for (const line of shown) {
      for (const sentence of line.split(/(?<=[.!?…])\s+/)) {
        const words = sentence.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
        expect(words.length, sentence).toBeLessThanOrEqual(12);
      }
    }
    // The old reserve line and the per-token buttons are gone; the "?" says why each token is its own channel.
    expect(Object.keys(C)).not.toContain("HOLD_AT_LEAST");
    expect(Object.keys(C)).not.toContain("OPEN_CHANNEL");
    const tip = C.TIP(CHANNEL_RESERVE_CKB.CKB, CHANNEL_RESERVE_CKB.UDT).join(" ");
    expect(tip).toContain("Each token is its own channel and its own transaction on chain");
    expect(tip).toContain("The hub funds token channels alone");
    expect(tip).toContain("Fiber cannot add funds to an open channel yet: to put in more CKB, close the CKB channel, then open a new one.");
  });
});

/* ------------------------------------------------------------------------------------- your own tokens */

/** The hub with cWBTC open to node-opened channels (peerChannels), as testnet-vps serves it: at least 0.01 cWBTC. */
const PEER = { minAmount: "1000000", assumedCommitmentDelayEpochs: 84 };
const withOwn = (patch: Partial<FiberNodeDto["inbound"]> = {}, peer: Record<string, typeof PEER | null> = { CWBTC: PEER }): FiberNodeDto => {
  const node = hubNode(patch);
  node.assets = node.assets.map((a) => ({ ...a, peerChannels: peer[a.id] ?? null }));
  return node;
};

test.describe("hub channel rows: a token the node may fund with its own tokens (the hub's peerChannels)", () => {
  test("the hub's offer, read safely: a u128 minimum and the token's script; null for CKB, null or missing, or a bad minimum", () => {
    expect(ownTokenOffer({ id: "CWBTC", udtTypeScript: CWBTC, peerChannels: PEER })).toEqual({ minAmount: BigInt(1_000_000), udtTypeScript: CWBTC });
    expect(ownTokenOffer({ id: "CWBTC", udtTypeScript: CWBTC, peerChannels: null })).toBeNull();
    // An older hub sends no field at all.
    expect(ownTokenOffer({ id: "CWBTC", udtTypeScript: CWBTC })).toBeNull();
    expect(ownTokenOffer({ id: "CKB", udtTypeScript: null, peerChannels: PEER })).toBeNull();
    expect(ownTokenOffer({ id: "CWBTC", udtTypeScript: null, peerChannels: PEER })).toBeNull();
    for (const minAmount of ["", "-1", "1.5", "0x10", "1e6", (BigInt(1) << BigInt(128)).toString()]) {
      expect(ownTokenOffer({ id: "CWBTC", udtTypeScript: CWBTC, peerChannels: { ...PEER, minAmount } }), minAmount).toBeNull();
    }
  });

  test("rows: a token with peerChannels offers both; the hub alone without it; production (peerChannels null everywhere) is unchanged", () => {
    const rows = hubRows(withOwn(), [], []);
    expect(rows.map((r) => [r.asset, r.hubFunds, r.own?.minAmount ?? null])).toEqual([
      ["CKB", true, null],
      ["RUSD", true, null],
      ["CWBTC", true, BigInt(1_000_000)],
    ]);
    expect(rows.map((r) => offersFundingChoice(r))).toEqual([false, false, true]);
    expect(rowFunding(rows[2], false)).toBe("hub");
    expect(rowFunding(rows[2], true)).toBe("own");
    // RUSD has no peerChannels: the hub funds it whatever was chosen.
    expect(rowFunding(rows[1], true)).toBe("hub");
    // Today's production hub: every row as before, no choice anywhere.
    const plain = hubRows(hubNode(), [], []);
    expect(plain.every((r) => r.own === null && !offersFundingChoice(r))).toBe(true);
    expect(plain.map((r) => r.hubAmount)).toEqual([BigInt(100_000_000_000), BigInt(1_000_000_000), BigInt(10_000_000)]);
  });

  test("the hub cannot fund it now, or funds no inbound channel in it at all: the node's own tokens are the way, with no choice", () => {
    // cWBTC: the hub says it cannot fund one now; the row stays open to the node's own channel, not "cannot fund".
    const short = hubRows(withOwn({ fundable: { CKB: true, RUSD: false, CWBTC: false } }), [], []);
    expect(kinds(short)).toEqual({ CKB: "available", RUSD: "unfundable", CWBTC: "available" });
    expect(short[2]).toMatchObject({ hubFunds: false, hubAmount: BigInt(10_000_000) });
    expect(offersFundingChoice(short[2])).toBe(false);
    expect(rowFunding(short[2], false)).toBe("own");
    // A token the hub opens no inbound channel in, but lets nodes open their own: a row of its own tokens only.
    const peerOnly = withOwn({ amounts: { CKB: "100000000000", RUSD: "1000000000" } });
    expect(hubRowAssets(peerOnly)).toEqual(["CKB", "RUSD", "CWBTC"]);
    expect(hubRows(peerOnly, [], [])[2]).toMatchObject({ asset: "CWBTC", hubAmount: null, hubFunds: false, state: { kind: "available" } });
    // Inbound channels off altogether: only the tokens nodes may fund themselves are rows.
    expect(hubRowAssets(withOwn({ enabled: false }))).toEqual(["CWBTC"]);
    // A channel with the hub in cWBTC, whoever opened it, is Open; a restart still wins over the offer.
    expect(kinds(hubRows(withOwn(), [channel({ udt: CWBTC, local: BigInt(5_000_000) })], []))).toMatchObject({ CWBTC: "open" });
    expect(kinds(hubRows(withOwn(), [], ["CWBTC"]))).toMatchObject({ CWBTC: "restart" });
  });

  test("the amount: at least the hub's minimum, at most what the node holds on chain, read first; Max is all it holds", () => {
    const check = (text: string, balance: bigint | null) =>
      checkOwnAmount({ text, decimals: 8, symbol: "cWBTC", minAmount: BigInt(1_000_000), balance, decimalMark: "." });
    expect(check("0.01", BigInt(5_000_000))).toEqual({ ok: true, amount: BigInt(1_000_000) });
    expect(check("0.05", BigInt(5_000_000))).toEqual({ ok: true, amount: BigInt(5_000_000) });
    expect(check("", BigInt(5_000_000))).toEqual({ ok: false, error: "Enter at least 0.01 cWBTC." });
    expect(check("0.000000001", BigInt(5_000_000))).toEqual({ ok: false, error: "Enter at least 0.01 cWBTC." });
    expect(check("0.005", BigInt(5_000_000))).toEqual({ ok: false, error: "Put in at least 0.01 cWBTC." });
    expect(check("0.01", null)).toEqual({ ok: false, error: "Wait until the node has read its cWBTC." });
    expect(check("0.01", BigInt(0))).toEqual({ ok: false, error: "Your node holds no cWBTC on chain." });
    expect(check("0.1", BigInt(5_000_000))).toEqual({ ok: false, error: "Your node holds only 0.05 cWBTC on chain." });
    // The page writes the minimum and Max with the locale's decimal mark, so they read back as written: with "." in a
    // comma locale, "1.125" would be 1,125 cWBTC, a thousand times the amount shown.
    const comma = (text: string) =>
      checkOwnAmount({ text, decimals: 8, symbol: "cWBTC", minAmount: BigInt(112_500_000), balance: BigInt(200_000_000_000), decimalMark: "," });
    expect(ownAmountText(BigInt(112_500_000), 8)).toBe("1.125");
    expect(ownAmountText(BigInt(112_500_000), 8, ",")).toBe("1,125");
    expect(ownAmountText(BigInt(5_000_000), 8, ",")).toBe("0,05");
    expect(ownAmountText(BigInt(200_000_000), 8, ",")).toBe("2");
    expect(comma(ownAmountText(BigInt(112_500_000), 8, ","))).toEqual({ ok: true, amount: BigInt(112_500_000) });
    expect(comma("1.125")).toEqual({ ok: true, amount: BigInt(112_500_000_000) });
    expect(maxOwnAmount(BigInt(5_000_000), BigInt(1_000_000))).toBe(BigInt(5_000_000));
    expect(maxOwnAmount(BigInt(999_999), BigInt(1_000_000))).toBeNull();
    expect(maxOwnAmount(BigInt(0), BigInt(0))).toBeNull();
    expect(maxOwnAmount(null, BigInt(1))).toBeNull();
    // The CKB it needs is a token channel's reserve, as when the hub funds it: 181 CKB in the total.
    expect(selectionNeeds(["CWBTC"], 1_200, ckbToShannons(600))).toEqual({ neededCkb: 181, haveCkb: 600, enough: true, shortCkb: 0 });
    for (const message of [OWN_TOKEN_MESSAGE.AMOUNT("0.01", "cWBTC"), OWN_TOKEN_MESSAGE.SHORT("1,234.5678", "cWBTC"), OWN_TOKEN_MESSAGE.READING("cWBTC")]) {
      expect(message.split(/\s+/).length, message).toBeLessThanOrEqual(12);
    }
  });

  test("the run: a row the node funds itself opens its own channel, the hub is not asked for it; the others go to the hub, in order", async () => {
    const events: string[] = [];
    const request = runRowRequest({
      own: { CWBTC: BigInt(5_000_000) },
      askHub: async (asset) => void events.push(`hub ${asset}`),
      openOwn: async (asset, amount) => void events.push(`own ${asset} ${amount}`),
    });
    const { deps } = harness();
    const outcome = await runHubRequests(["CKB", "CWBTC", "RUSD"], { ...deps, request, waitForFunding: async (asset) => void events.push(`wait ${asset}`) });
    expect(events).toEqual(["hub CKB", "wait CKB", "own CWBTC 5000000", "wait CWBTC", "hub RUSD"]);
    expect(outcome).toEqual({ done: ["CKB", "CWBTC", "RUSD"], failed: [], skipped: [] });
    // fnn refusing the node's own channel fails that row only.
    const failing = runRowRequest({
      own: { CWBTC: BigInt(1_000_000) },
      askHub: async () => undefined,
      openOwn: async () => {
        throw new Error('ErrorObject { code: ServerError(-32000), message: "Invalid UDT type script" }');
      },
    });
    const second = harness();
    const result = await runHubRequests(["CWBTC", "CKB"], { ...second.deps, request: failing });
    expect(result).toEqual({ done: ["CKB"], failed: ["CWBTC"], skipped: [] });
    expect(second.trace.rows.CWBTC.at(-1)).toEqual({ status: "failed", reason: "Invalid UDT type script" });
  });

  test("the node's open_channel: to the hub's id, in the token, private, the amount typed; no delay of its own; recorded in History", async () => {
    const offer = ownTokenOffer({ id: "CWBTC", udtTypeScript: CWBTC, peerChannels: PEER })!;
    const plan = ownChannelPlan({ nodeId: HUB_NODE_ID, address: "/dns4/hub.example.test/tcp/443/wss" }, "CWBTC", offer, BigInt(5_000_000));
    expect(plan).toEqual({
      address: `/dns4/hub.example.test/tcp/443/wss/p2p/${peerIdOf(HUB_NODE_ID)}`,
      peerId: HUB_NODE_ID,
      asset: "CWBTC",
      fundingAmount: BigInt(5_000_000),
      udtTypeScript: CWBTC,
    });
    const opens: OpenChannelArgs[] = [];
    const dials: string[] = [];
    const fakeNode = (peers: string[]) =>
      ({
        listPeers: async () => peers,
        connectPeer: async (address: string) => {
          dials.push(address);
          peers.push(HUB_NODE_ID);
        },
        openChannel: async (args: OpenChannelArgs) => {
          opens.push(args);
          return { temporaryChannelId: `0x${"ab".repeat(32)}` };
        },
      }) as unknown as BrowserFiberNode;
    const format = (asset: FiberAssetId, amount: string) => `${Number(amount) / 1e8} ${asset === "CWBTC" ? "cWBTC" : asset}`;
    const history = { channels: [], assetOf: () => "CWBTC" };
    const deps = { pollMs: 1, timeoutMs: 100, sleep: async () => undefined, now: () => 0 };
    // The hub's offer, read again just before the open: unchanged here.
    const offering = (peerChannels: typeof PEER | null = PEER, nodeId = HUB_NODE_ID) => async () => ({
      nodeId,
      assets: [{ id: "CWBTC", udtTypeScript: CWBTC, udtWhitelist: null, peerChannels }],
    });
    const hubNow = offering();
    const result = await openOwnTokenChannel(fakeNode([HUB_NODE_ID]), plan, format, history, hubNow, deps);
    expect(opens).toEqual([{ peerId: HUB_NODE_ID, fundingAmount: BigInt(5_000_000), isPublic: false, udtTypeScript: CWBTC }]);
    expect(dials).toEqual([]);
    expect(result.message).toBe("Your node is opening a channel of 0.05 cWBTC to the hub. It reads Ready after a few confirmations.");
    expect(result.entry).toMatchObject({ kind: "channel", asset: "CWBTC", amount: "5000000", counterparty: HUB_NODE_ID, channel: { action: "open", channelId: null } });
    // No longer a peer: dialled first, at the hub's address with its peer id.
    await openOwnTokenChannel(fakeNode([]), plan, format, history, hubNow, deps);
    expect(dials).toEqual([plan.address]);
    // Not a peer and no address to dial: says so, opens nothing.
    await expect(openOwnTokenChannel(fakeNode([]), { ...plan, address: "" }, format, history, hubNow, deps)).rejects.toThrow(HUB_PANEL_COPY.CONNECT_FIRST);
    await expect(openOwnTokenChannel(null, plan, format, history, hubNow, deps)).rejects.toThrow(HUB_PANEL_COPY.START_FIRST);
    expect(opens).toHaveLength(2);

    // The page read the hub once: the offer as it stands now decides. The hub at its cap of such channels (every
    // peerChannels null), another hub node, a raised minimum, or a hub that cannot be read: nothing is opened.
    const node = fakeNode([HUB_NODE_ID]);
    await expect(openOwnTokenChannel(node, plan, format, history, offering(null), deps)).rejects.toThrow(OWN_OFFER_MESSAGE.GONE);
    await expect(openOwnTokenChannel(node, plan, format, history, offering(PEER, OTHER_NODE_ID), deps)).rejects.toThrow(OWN_OFFER_MESSAGE.GONE);
    await expect(
      openOwnTokenChannel(node, plan, format, history, offering({ minAmount: "6000000", assumedCommitmentDelayEpochs: 84 }), deps),
    ).rejects.toThrow("The hub now asks for at least 0.06 cWBTC.");
    await expect(
      openOwnTokenChannel(node, plan, format, history, async () => Promise.reject(new Error("fetch failed")), deps),
    ).rejects.toThrow();
    expect(opens).toHaveLength(2);
    // The same minimum, or a lower one, still opens; the hub's id in another case or with 0x is the same node.
    await openOwnTokenChannel(node, plan, format, history, offering({ minAmount: "5000000", assumedCommitmentDelayEpochs: 84 }, `0x${HUB_NODE_ID.toUpperCase()}`), deps);
    expect(opens).toHaveLength(3);
    for (const message of [OWN_OFFER_MESSAGE.GONE, OWN_OFFER_MESSAGE.MIN("1,234.5678 cWBTC")]) {
      for (const sentence of message.split(/(?<=[.!?])\s+/)) expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(12);
    }
  });

  test("the copy: the choice, the line, the field's lines, each within 12 words; the trade-off behind the row's \"?\"", () => {
    const C = HUB_PANEL_COPY;
    expect(C.FUND_OWN("cWBTC")).toBe("Your own cWBTC");
    expect(C.OWN_OFFER("181")).toBe("Your node funds it · needs 181 CKB reserve");
    expect(C.OWN_HOLDS("0.05 cWBTC", "0.01 cWBTC")).toBe("You hold 0.05 cWBTC on chain · at least 0.01 cWBTC");
    for (const line of [
      C.FUNDING_LABEL("cWBTC"),
      C.FUND_HUB,
      C.FUND_OWN("cWBTC"),
      C.OWN_OFFER("181"),
      C.OWN_HOLDS("1,234.56789 cWBTC", "0.01 cWBTC"),
      C.OWN_READING("cWBTC"),
      C.OWN_READ_FAILED("cWBTC"),
      C.READ_AGAIN,
      C.OWN_TIP_LABEL("cWBTC"),
      ...Object.values(OWN_TOKEN_MESSAGE).map((m) => m("0.01", "cWBTC")),
    ]) {
      for (const sentence of line.split(/(?<=[.!?…])\s+/)) {
        const words = sentence.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
        expect(words.length, sentence).toBeLessThanOrEqual(12);
      }
    }
    const tip = C.OWN_TIP("cWBTC", CHANNEL_RESERVE_CKB.UDT).join(" ");
    expect(tip).toContain("pay the hub up to what it put in");
    expect(tip).toContain("The hub adds no cWBTC");
    // The longer hold is the token's, whichever channel pays a swap (the hub sizes every hold in it for 84 epochs).
    expect(tip).toContain("the hub plans every swap from cWBTC to BTC for the longest safety delay, over the hub's channel or yours.");
    expect(tip).toContain("your payment could stay locked up to about 10 days");
    expect(tip).not.toContain("Swaps paid over it may hold your payment longer");
    // The card's own "?" names the tokens a node may fund itself, and only when there are some.
    expect(C.TIP(99, 180, ["cWBTC"]).join(" ")).toContain("For cWBTC, your node may instead open the channel with its own tokens, and the hub adds none");
    expect(C.TIP(99, 180).join(" ")).not.toContain("its own tokens");
  });
});
