import "reflect-metadata";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Global, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type Database from "better-sqlite3";
import { FiberNodeModule } from "../../../src/application/fiber-node/fiber-node.module";
import { INBOUND_CHANNELS, type InboundChannels } from "../../../src/application/fiber-node/inbound-channels.contract";
import { InboundChannelsService } from "../../../src/application/fiber-node/inbound-channels.service";
import { abandonStaleInboundOpens, InboundOpenRequests } from "../../../src/application/fiber-node/stale-inbound-opens";
import type { ChannelOpen, ChannelOpenLog } from "../../../src/application/ports/channel-open-log.port";
import type { FiberChannel } from "../../../src/application/ports/fiber.port";
import type { InboundOpenStore } from "../../../src/application/ports/inbound-open-store.port";
import { CLOCK, FIBER, HUB_CONFIG, INBOUND_OPEN_STORE } from "../../../src/application/ports/tokens";
import type { ChannelOpenKind } from "../../../src/common/constants/channel-opens.constants";
import { FIBER_CHANNEL_STATUS, INBOUND_CHANNEL_MIN_ACCEPT_TIMEOUT_SECONDS } from "../../../src/common/constants/fiber-node.constants";
import { FIBER_RPC_METHOD } from "../../../src/common/constants/fiber-rpc.constants";
import { SQLITE_IN_MEMORY_PATH } from "../../../src/common/constants/persistence.constants";
import { MS_PER_SECOND } from "../../../src/common/constants/protocol.constants";
import { canonicalHex } from "../../../src/common/utils/hex.util";
import { HubConfigModule } from "../../../src/config/config.module";
import { assetRegistryOf, loadHubConfig, type HubConfig } from "../../../src/config/hub.config";
import { toChannelDetails } from "../../../src/infrastructure/fiber/fiber-rpc.mappers";
import { FIBER_RPC_RESULT_SCHEMAS, type RpcChannel } from "../../../src/infrastructure/fiber/fiber-rpc.schemas";
import { PersistenceModule } from "../../../src/infrastructure/persistence/persistence.module";
import { SqliteChannelOpenLog } from "../../../src/infrastructure/persistence/sqlite-channel-open-log";
import { SqliteInboundOpenStore } from "../../../src/infrastructure/persistence/sqlite-inbound-open-store";
import { openHubDatabase } from "../../../src/infrastructure/persistence/sqlite.database";
import { FakeClock, FakeFiberNetwork, FakeInboundOpenStore, FakeSwapStore, type FakeFiberNode } from "../../fakes";

/**
 * Inbound channels nobody accepts (a browser node accepts the hub's CKB channel itself; a closed tab never does): the
 * hub abandons one that waited longer than FIBER_INBOUND_ACCEPT_TIMEOUT_SECONDS whenever it reads its inbound channels,
 * so the node can ask again and the channel stops counting against the hub's caps and funding room. fnn alone would
 * keep it for its one-day funding timeout (fnn v0.9.1 DEFAULT_FUNDING_TIMEOUT_SECONDS).
 *
 * Only an open the hub asked for (InboundOpenRequests, kept in the hub's database through InboundOpenStore): fnn v0.9.1
 * lists every channel still waiting for its peer (`only_pending`) with `is_public: false`, so a public channel an
 * operator opened over fnn's RPC reads like an inbound one. The record survives a restart, so an open from before it is
 * still given up, timed from when the hub asked.
 */

const ONE_CKB = 100_000_000n;
const BROWSER_NODE = `02${"b1".repeat(32)}`;
const OTHER_NODE = `03${"c2".repeat(32)}`;
const RELAY_NODE = `02${"ee".repeat(32)}`;
const THIRD_NODE = `02${"f0".repeat(32)}`;
const CLIENT = "203.0.113.50";
const OTHER_CLIENT = "198.51.100.9";
const TIMEOUT_SECONDS = 600;

const config = (patch: Record<string, string> = {}): HubConfig =>
  loadHubConfig({
    HUB_DB_PATH: SQLITE_IN_MEMORY_PATH,
    FIBER_PUBLIC_P2P_ADDRS: "/ip4/203.0.113.7/tcp/8228",
    FIBER_INBOUND_ENABLED: "true",
    FIBER_INBOUND_CKB_AMOUNT: (500n * ONE_CKB).toString(),
    ...patch,
  });

/** The daily caps' log, in memory. */
class MemoryOpenLog implements ChannelOpenLog {
  private readonly opens: ChannelOpen[] = [];
  record(open: ChannelOpen): void {
    this.opens.push(open);
  }
  listAfter(kind: ChannelOpenKind, after: number): ChannelOpen[] {
    return this.opens.filter((open) => open.kind === kind && open.openedAt > after);
  }
  forgetBefore(before: number): void {
    this.opens.splice(0, this.opens.length, ...this.opens.filter((open) => open.openedAt >= before));
  }
}

const routing: FiberChannel = {
  channelId: `0x${"11".repeat(32)}`,
  peer: RELAY_NODE,
  udtTypeScript: null,
  ready: true,
  localBalance: 100_000n * ONE_CKB,
  remoteBalance: 100_000n * ONE_CKB,
  status: FIBER_CHANNEL_STATUS.READY,
  public: true,
  openedByPeer: false,
};

function harness(patch: Record<string, string> = {}) {
  const hubConfig = config(patch);
  const clock = new FakeClock();
  const node: FakeFiberNode = new FakeFiberNetwork(hubConfig.ckb.network, clock).node("hub");
  node.setChannels([routing]);
  const openLog = new MemoryOpenLog();
  const inboundOpens = new FakeInboundOpenStore();
  /** A hub process on this node: a second call plays a restart (the caps' log and the opens are the database, so stay). */
  const start = () =>
    new InboundChannelsService(
      node,
      new FakeSwapStore(clock),
      assetRegistryOf(hubConfig),
      openLog,
      inboundOpens,
      clock,
      hubConfig,
    );
  return { service: start(), restart: start, node, clock, inboundOpens };
}

const open = (service: InboundChannelsService, nodeId = BROWSER_NODE) => service.open({ nodeId, asset: "CKB", clientKey: CLIENT });

const waiting = (overrides: Partial<FiberChannel> = {}): FiberChannel => ({
  channelId: `0x${"aa".repeat(32)}`,
  peer: BROWSER_NODE,
  udtTypeScript: null,
  ready: false,
  localBalance: 500n * ONE_CKB,
  remoteBalance: 0n,
  status: FIBER_CHANNEL_STATUS.OPENING,
  public: false,
  openedByPeer: false,
  awaitingAcceptSince: 1_000,
  ...overrides,
});

const quietLogger = () => ({ log: jest.fn(), warn: jest.fn() });

/** When the hub asked for the opens in `waiting()` (1_000), and the first moment they are overdue. */
const ASKED_AT = 1_000;
const DUE = ASKED_AT + TIMEOUT_SECONDS * MS_PER_SECOND;

/** The opens this hub process asked for: each channel's id and peer, asked at `askedAt`. */
const asked = (channels: readonly FiberChannel[], askedAt = ASKED_AT): InboundOpenRequests => {
  const requests = new InboundOpenRequests(new FakeInboundOpenStore(), TIMEOUT_SECONDS);
  for (const channel of channels) requests.remember(channel.channelId, channel.peer, askedAt);
  return requests;
};

describe("stale inbound opens", () => {
  describe("InboundOpenRequests", () => {
    it("is overdue once it has waited the timeout, to its peer or to any peer, under any spelling of its id", () => {
      const requests = new InboundOpenRequests(new FakeInboundOpenStore(), TIMEOUT_SECONDS);
      requests.remember(`0x${"AA".repeat(32)}`, BROWSER_NODE, ASKED_AT);
      expect(requests.overdue(DUE - 1)).toEqual([]);
      expect(requests.overdue(DUE)).toEqual(["aa".repeat(32)]);
      expect(requests.overdue(DUE, BROWSER_NODE)).toEqual(["aa".repeat(32)]);
      expect(requests.overdue(DUE, OTHER_NODE)).toEqual([]);
      requests.forget(`0x${"aa".repeat(32)}`);
      expect(requests.overdue(DUE)).toEqual([]);
    });

    it("keeps each request in its store, by canonical id, the peer and when the hub asked", () => {
      const store = new FakeInboundOpenStore();
      new InboundOpenRequests(store, TIMEOUT_SECONDS).remember(`0x${"AA".repeat(32)}`, BROWSER_NODE, ASKED_AT);
      expect(store.all()).toEqual([{ temporaryChannelId: "aa".repeat(32), peer: BROWSER_NODE, askedAt: ASKED_AT }]);
    });

    it("a registry over the same store (a restarted hub) sees, ages and forgets what the first one remembered", () => {
      const store = new FakeInboundOpenStore();
      new InboundOpenRequests(store, TIMEOUT_SECONDS).remember(`0x${"aa".repeat(32)}`, BROWSER_NODE, ASKED_AT);
      const restarted = new InboundOpenRequests(store, TIMEOUT_SECONDS);
      expect(restarted.overdue(DUE - 1)).toEqual([]);
      expect(restarted.overdue(DUE, BROWSER_NODE)).toEqual(["aa".repeat(32)]);
      restarted.forget(`0x${"AA".repeat(32)}`);
      expect(store.all()).toEqual([]);
    });

    it("lists overdue requests oldest first, and asking again for one id moves its clock", () => {
      const requests = new InboundOpenRequests(new FakeInboundOpenStore(), TIMEOUT_SECONDS);
      requests.remember(`0x${"bb".repeat(32)}`, OTHER_NODE, ASKED_AT + 1);
      requests.remember(`0x${"aa".repeat(32)}`, BROWSER_NODE, ASKED_AT);
      expect(requests.overdue(DUE + 1)).toEqual(["aa".repeat(32), "bb".repeat(32)]);
      requests.remember(`0x${"aa".repeat(32)}`, BROWSER_NODE, ASKED_AT + 2);
      expect(requests.overdue(DUE + 1)).toEqual(["bb".repeat(32)]);
    });
  });

  describe("abandonStaleInboundOpens", () => {
    it("never abandons a pending open the hub did not ask for, however old (fnn lists an operator's public one as private)", async () => {
      // As fnn v0.9.1 lists any channel still waiting for its peer (only_pending): private, opened by this node.
      const operators = waiting({ channelId: `0x${"dd".repeat(32)}`, peer: OTHER_NODE });
      const fiber = { abandonChannel: jest.fn() };
      const requests = asked([waiting()]);
      const left = await abandonStaleInboundOpens(fiber, requests, { channels: [routing, operators] }, 10 * DUE, quietLogger());
      expect(fiber.abandonChannel).not.toHaveBeenCalled();
      expect(left).toEqual([routing, operators]);
    });

    it("abandons an open it asked for once the peer has not accepted it within the timeout, and forgets it", async () => {
      const stale = waiting();
      const fiber = { abandonChannel: jest.fn(async () => undefined) };
      const requests = asked([stale]);
      const logger = quietLogger();
      const left = await abandonStaleInboundOpens(fiber, requests, { channels: [routing, stale] }, DUE, logger);
      expect(fiber.abandonChannel).toHaveBeenCalledWith(stale.channelId);
      expect(left).toEqual([routing]);
      expect(requests.overdue(DUE)).toEqual([]);
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining(`not accepted within ${TIMEOUT_SECONDS} s`));
    });

    it("keeps an open it asked for while the peer still has time to accept it", async () => {
      const fresh = waiting();
      const fiber = { abandonChannel: jest.fn() };
      const requests = asked([fresh]);
      const left = await abandonStaleInboundOpens(fiber, requests, { channels: [routing, fresh] }, DUE - 1, quietLogger());
      expect(fiber.abandonChannel).not.toHaveBeenCalled();
      expect(left).toEqual([routing, fresh]);
      expect(requests.overdue(DUE)).toHaveLength(1);
    });

    it("one fnn refuses stays in the list and in the record, is only logged, and is tried again next time", async () => {
      const refused = waiting();
      const fiber = { abandonChannel: jest.fn().mockRejectedValueOnce(new Error("Channel cannot be abandoned")).mockResolvedValue(undefined) };
      const requests = asked([refused]);
      const logger = quietLogger();
      expect(await abandonStaleInboundOpens(fiber, requests, { channels: [refused] }, DUE, logger)).toEqual([refused]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Channel cannot be abandoned"));
      expect(await abandonStaleInboundOpens(fiber, requests, { channels: [refused] }, DUE, logger)).toEqual([]);
      expect(fiber.abandonChannel).toHaveBeenCalledTimes(2);
    });

    it("forgets an overdue open that no longer waits (accepted, or no longer listed) and asks fnn nothing", async () => {
      const accepted = waiting({ awaitingAcceptSince: undefined });
      const gone = waiting({ channelId: `0x${"bb".repeat(32)}` });
      const fiber = { abandonChannel: jest.fn() };
      const requests = asked([accepted, gone]);
      expect(await abandonStaleInboundOpens(fiber, requests, { channels: [routing, accepted] }, DUE, quietLogger())).toEqual([routing, accepted]);
      expect(fiber.abandonChannel).not.toHaveBeenCalled();
      expect(requests.overdue(DUE)).toEqual([]);
    });

    it("a listing of one node's channels touches only the opens asked for to that node", async () => {
      const mine = waiting();
      const others = waiting({ channelId: `0x${"bb".repeat(32)}`, peer: OTHER_NODE });
      const fiber = { abandonChannel: jest.fn(async () => undefined) };
      const requests = asked([mine, others]);
      await abandonStaleInboundOpens(fiber, requests, { channels: [mine], peer: BROWSER_NODE }, DUE, quietLogger());
      expect(fiber.abandonChannel.mock.calls).toEqual([[mine.channelId]]);
      // The other node's open was not in that listing: it stays on record, to be abandoned when a listing shows it.
      expect(requests.overdue(DUE)).toEqual(["bb".repeat(32)]);
    });
  });

  describe("InboundChannelsService with an open the node never accepts", () => {
    beforeEach(() => jest.spyOn(console, "log").mockImplementation(() => undefined));
    afterEach(() => jest.restoreAllMocks());

    it("refuses a second request while the first waits, then abandons it after the timeout and opens again", async () => {
      const h = harness();
      h.node.connectPeer(BROWSER_NODE);
      const first = await open(h.service);
      expect(await h.service.list(BROWSER_NODE)).toEqual([expect.objectContaining({ channelId: first.temporaryChannelId, state: "opening" })]);
      // Still within the timeout: one channel per node and asset, the waiting one included.
      h.clock.advance(TIMEOUT_SECONDS * MS_PER_SECOND - 1);
      await expect(open(h.service)).rejects.toMatchObject({ status: 409 });
      // Past it: the hub gives the open up, and the node may ask again.
      h.clock.advance(1);
      const abandon = jest.spyOn(h.node, "abandonChannel");
      const second = await open(h.service);
      expect(abandon).toHaveBeenCalledWith(first.temporaryChannelId);
      expect(second.temporaryChannelId).not.toBe(first.temporaryChannelId);
      const channels = await h.node.listChannelDetails(BROWSER_NODE);
      expect(channels.map((c) => c.channelId)).toEqual([second.temporaryChannelId]);
    });

    it("listing a node's inbound channels drops its stale open, so the page stops showing it as opening", async () => {
      const h = harness();
      h.node.connectPeer(BROWSER_NODE);
      await open(h.service);
      h.clock.advance(TIMEOUT_SECONDS * MS_PER_SECOND);
      expect(await h.service.list(BROWSER_NODE)).toEqual([]);
      expect(await h.node.listChannelDetails(BROWSER_NODE)).toEqual([]);
    });

    it("never abandons an open the node accepted, however long its funding takes", async () => {
      const h = harness();
      h.node.connectPeer(BROWSER_NODE);
      const opening = await open(h.service);
      h.node.acceptChannelOpenings();
      h.clock.advance(10 * TIMEOUT_SECONDS * MS_PER_SECOND);
      const abandon = jest.spyOn(h.node, "abandonChannel");
      expect(await h.service.list(BROWSER_NODE)).toEqual([expect.objectContaining({ channelId: opening.temporaryChannelId, state: "opening" })]);
      expect(abandon).not.toHaveBeenCalled();
    });

    it("never abandons a pending channel it did not open itself (an operator's, over fnn's RPC), however long it waits", async () => {
      const h = harness();
      h.node.connectPeer(BROWSER_NODE);
      // As fnn v0.9.1 lists it while the peer has not accepted: private and opened by the hub's node, like an inbound one.
      const operators = waiting({ channelId: `0x${"dd".repeat(32)}`, peer: OTHER_NODE, awaitingAcceptSince: h.clock.now() });
      h.node.setChannels([routing, operators]);
      h.clock.advance(10 * TIMEOUT_SECONDS * MS_PER_SECOND);
      const abandon = jest.spyOn(h.node, "abandonChannel");
      await open(h.service);
      expect(await h.service.list(OTHER_NODE)).toEqual([expect.objectContaining({ channelId: operators.channelId, state: "opening" })]);
      expect(abandon).not.toHaveBeenCalled();
    });

    it("remembers each open it made in the store, by canonical id, with the node and the hub's time", async () => {
      const h = harness();
      h.node.connectPeer(BROWSER_NODE);
      const opening = await open(h.service);
      expect(h.inboundOpens.all()).toEqual([{ temporaryChannelId: canonicalHex(opening.temporaryChannelId), peer: BROWSER_NODE, askedAt: h.clock.now() }]);
    });

    it("forgets an open once abandoned, so a later read asks fnn nothing more about it", async () => {
      const h = harness();
      h.node.connectPeer(BROWSER_NODE);
      await open(h.service);
      h.clock.advance(TIMEOUT_SECONDS * MS_PER_SECOND);
      expect(await h.service.list(BROWSER_NODE)).toEqual([]);
      expect(h.inboundOpens.all()).toEqual([]);
    });

    it("frees a place under FIBER_INBOUND_MAX_OPEN for another node", async () => {
      const h = harness({ FIBER_INBOUND_MAX_OPEN: "1" });
      h.node.connectPeer(BROWSER_NODE);
      h.node.connectPeer(OTHER_NODE);
      await open(h.service, BROWSER_NODE);
      await expect(open(h.service, OTHER_NODE)).rejects.toMatchObject({ status: 429 });
      h.clock.advance(TIMEOUT_SECONDS * MS_PER_SECOND);
      await expect(open(h.service, OTHER_NODE)).resolves.toMatchObject({ nodeId: OTHER_NODE });
    });
  });

  describe("InboundChannelsService across a hub restart (the opens are in the hub's database)", () => {
    beforeEach(() => jest.spyOn(console, "log").mockImplementation(() => undefined));
    afterEach(() => jest.restoreAllMocks());

    it("abandons an open from before the restart once overdue, and the node may ask again", async () => {
      const h = harness();
      h.node.connectPeer(BROWSER_NODE);
      const before = await open(h.service);
      const restarted = h.restart();
      h.clock.advance(TIMEOUT_SECONDS * MS_PER_SECOND);
      const abandon = jest.spyOn(h.node, "abandonChannel");
      const again = await open(restarted);
      expect(abandon.mock.calls).toEqual([[before.temporaryChannelId]]);
      expect((await h.node.listChannelDetails(BROWSER_NODE)).map((c) => c.channelId)).toEqual([again.temporaryChannelId]);
    });

    it("times the open from when the hub asked, not from the restart", async () => {
      const h = harness();
      h.node.connectPeer(BROWSER_NODE);
      const before = await open(h.service);
      h.clock.advance((TIMEOUT_SECONDS / 2) * MS_PER_SECOND);
      const restarted = h.restart();
      h.clock.advance((TIMEOUT_SECONDS / 2) * MS_PER_SECOND - 1);
      await expect(open(restarted)).rejects.toMatchObject({ status: 409 });
      h.clock.advance(1);
      const abandon = jest.spyOn(h.node, "abandonChannel");
      expect(await restarted.list(BROWSER_NODE)).toEqual([]);
      expect(abandon.mock.calls).toEqual([[before.temporaryChannelId]]);
    });

    it("never touches a pending channel it did not open, however old, while abandoning its own from before the restart", async () => {
      const h = harness();
      h.node.connectPeer(BROWSER_NODE);
      const mine = await open(h.service);
      // As fnn v0.9.1 lists an operator's public open while its peer has not accepted: private and opened by the hub's node.
      const operators = waiting({ channelId: `0x${"dd".repeat(32)}`, peer: OTHER_NODE, awaitingAcceptSince: h.clock.now() });
      const listed = await h.node.listChannelDetails();
      h.node.setChannels([...listed, operators]);
      const restarted = h.restart();
      h.clock.advance(10 * TIMEOUT_SECONDS * MS_PER_SECOND);
      const abandon = jest.spyOn(h.node, "abandonChannel");
      expect(await restarted.list(OTHER_NODE)).toEqual([expect.objectContaining({ channelId: operators.channelId, state: "opening" })]);
      expect(await restarted.list(BROWSER_NODE)).toEqual([]);
      expect(abandon.mock.calls).toEqual([[mine.temporaryChannelId]]);
      expect(await h.node.listChannelDetails(OTHER_NODE)).toEqual([expect.objectContaining({ channelId: operators.channelId })]);
    });

    it("forgets, at its first read once due, an open from before whose channel no longer waits or no longer exists", async () => {
      const h = harness();
      h.node.connectPeer(BROWSER_NODE);
      h.node.connectPeer(OTHER_NODE);
      const accepted = await open(h.service, BROWSER_NODE);
      await open(h.service, OTHER_NODE);
      h.node.acceptChannelOpenings();
      // The other node's channel is gone from fnn (failed, or fnn's data was reset) while the hub was down.
      h.node.setChannels((await h.node.listChannelDetails()).filter((c) => c.peer !== OTHER_NODE));
      const restarted = h.restart();
      h.clock.advance(TIMEOUT_SECONDS * MS_PER_SECOND);
      const abandon = jest.spyOn(h.node, "abandonChannel");
      // Any open reads every channel; a third node, from another client (each client gets 2 a day).
      h.node.connectPeer(THIRD_NODE);
      await restarted.open({ nodeId: THIRD_NODE, asset: "CKB", clientKey: OTHER_CLIENT });
      expect(abandon).not.toHaveBeenCalled();
      expect(h.inboundOpens.all().map((o) => o.peer)).toEqual([THIRD_NODE]);
      expect(await restarted.list(BROWSER_NODE)).toEqual([expect.objectContaining({ channelId: accepted.temporaryChannelId, state: "opening" })]);
    });

    it("keeps an open whose abandon fnn refused after the restart, and tries it again at the next read", async () => {
      const h = harness();
      h.node.connectPeer(BROWSER_NODE);
      const before = await open(h.service);
      const restarted = h.restart();
      h.clock.advance(TIMEOUT_SECONDS * MS_PER_SECOND);
      const abandon = jest.spyOn(h.node, "abandonChannel").mockRejectedValueOnce(new Error("Channel cannot be abandoned"));
      jest.spyOn(console, "warn").mockImplementation(() => undefined);
      jest.spyOn(console, "error").mockImplementation(() => undefined);
      expect(await restarted.list(BROWSER_NODE)).toEqual([expect.objectContaining({ channelId: before.temporaryChannelId })]);
      expect(h.inboundOpens.all()).toHaveLength(1);
      expect(await restarted.list(BROWSER_NODE)).toEqual([]);
      expect(abandon).toHaveBeenCalledTimes(2);
      expect(h.inboundOpens.all()).toEqual([]);
    });

    describe("on the hub's SQLite database file, closed and opened again", () => {
      let dir: string;
      const opened: Database.Database[] = [];

      beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "ckbolt-stale-opens-"))));
      afterEach(() => {
        for (const db of opened.splice(0)) if (db.open) db.close();
        rmSync(dir, { recursive: true, force: true });
      });

      it("a hub started on the file abandons the overdue open the previous one made, and nothing else", async () => {
        const hubConfig = config();
        const clock = new FakeClock();
        const node = new FakeFiberNetwork(hubConfig.ckb.network, clock).node("hub");
        const operators = waiting({ channelId: `0x${"dd".repeat(32)}`, peer: OTHER_NODE, awaitingAcceptSince: clock.now() });
        node.setChannels([routing, operators]);
        node.connectPeer(BROWSER_NODE);
        const path = join(dir, "hub.sqlite");
        const start = (): { service: InboundChannelsService; db: Database.Database } => {
          const db = openHubDatabase(path, clock);
          opened.push(db);
          const assets = assetRegistryOf(hubConfig);
          const stores = [new SqliteChannelOpenLog(db), new SqliteInboundOpenStore(db)] as const;
          return { service: new InboundChannelsService(node, new FakeSwapStore(clock), assets, ...stores, clock, hubConfig), db };
        };

        const first = start();
        const before = await open(first.service);
        first.db.close();
        clock.advance(TIMEOUT_SECONDS * MS_PER_SECOND);

        const second = start();
        const abandon = jest.spyOn(node, "abandonChannel");
        const again = await open(second.service);
        expect(abandon.mock.calls).toEqual([[before.temporaryChannelId]]);
        expect(new SqliteInboundOpenStore(second.db).listAskedBy(Number.MAX_SAFE_INTEGER)).toEqual([
          { temporaryChannelId: canonicalHex(again.temporaryChannelId), peer: BROWSER_NODE, askedAt: clock.now() },
        ]);
        expect((await node.listChannelDetails()).map((c) => c.channelId)).toEqual([routing.channelId, operators.channelId, again.temporaryChannelId]);
      });
    });

    it("is wired by Nest: FiberNodeModule gets INBOUND_OPEN_STORE from PersistenceModule", async () => {
      const clock = new FakeClock();
      const hubConfig = config();
      const node = new FakeFiberNetwork(hubConfig.ckb.network, clock).node("hub");
      node.setChannels([routing]);
      node.connectPeer(BROWSER_NODE);

      @Global()
      @Module({ providers: [{ provide: FIBER, useValue: node }], exports: [FIBER] })
      class FakeFiberModule {}

      const app = await Test.createTestingModule({ imports: [HubConfigModule, PersistenceModule, FakeFiberModule, FiberNodeModule] })
        .overrideProvider(HUB_CONFIG)
        .useValue(hubConfig)
        .overrideProvider(CLOCK)
        .useValue(clock)
        .compile();
      try {
        await app.init();
        const opening = await app.get<InboundChannels>(INBOUND_CHANNELS).open({ nodeId: BROWSER_NODE, asset: "CKB", clientKey: CLIENT });
        const store = app.get<InboundOpenStore>(INBOUND_OPEN_STORE);
        expect(store).toBeInstanceOf(SqliteInboundOpenStore);
        expect(store.listAskedBy(clock.now())).toEqual([{ temporaryChannelId: canonicalHex(opening.temporaryChannelId), peer: BROWSER_NODE, askedAt: clock.now() }]);
      } finally {
        await app.close();
      }
    });
  });

  describe("config and the fnn mapping", () => {
    it("FIBER_INBOUND_ACCEPT_TIMEOUT_SECONDS: 10 minutes by default, never under the browser node's own retries", () => {
      expect(config().fiberPeers.inboundChannels.acceptTimeoutSeconds).toBe(600);
      expect(config({ FIBER_INBOUND_ACCEPT_TIMEOUT_SECONDS: "120" }).fiberPeers.inboundChannels.acceptTimeoutSeconds).toBe(120);
      expect(() => config({ FIBER_INBOUND_ACCEPT_TIMEOUT_SECONDS: String(INBOUND_CHANNEL_MIN_ACCEPT_TIMEOUT_SECONDS - 1) })).toThrow();
    });

    const rpcChannel = (overrides: Partial<RpcChannel>): RpcChannel => ({
      channel_id: `0x${"aa".repeat(32)}`,
      pubkey: BROWSER_NODE,
      funding_udt_type_script: null,
      state: { state_name: "NegotiatingFunding" },
      is_acceptor: false,
      is_public: false,
      local_balance: "0xba43b7400",
      remote_balance: "0x0",
      pending_tlcs: [],
      created_at: "0x19a4c1b2c00",
      ...overrides,
    });

    it("reads when the hub asked from created_at, only on a channel it opened that the peer has not accepted", () => {
      expect(toChannelDetails(rpcChannel({})).awaitingAcceptSince).toBe(0x19a4c1b2c00);
      expect(toChannelDetails(rpcChannel({ state: { state_name: "CollaboratingFundingTx" } })).awaitingAcceptSince).toBeUndefined();
      expect(toChannelDetails(rpcChannel({ is_acceptor: true })).awaitingAcceptSince).toBeUndefined();
      expect(toChannelDetails(rpcChannel({ is_acceptor: undefined })).awaitingAcceptSince).toBeUndefined();
      expect(toChannelDetails(rpcChannel({ created_at: undefined })).awaitingAcceptSince).toBeUndefined();
      expect("awaitingAcceptSince" in toChannelDetails(rpcChannel({ state: { state_name: "ChannelReady" } }))).toBe(false);
    });

    it("marks every channel still NegotiatingFunding as negotiating (an open request not accepted yet included), no later state", () => {
      expect(toChannelDetails(rpcChannel({})).negotiating).toBe(true);
      expect(toChannelDetails(rpcChannel({ is_acceptor: true, created_at: undefined })).negotiating).toBe(true);
      for (const state_name of ["CollaboratingFundingTx", "SigningCommitment", "AwaitingChannelReady", "ChannelReady", "ShuttingDown"]) {
        expect("negotiating" in toChannelDetails(rpcChannel({ is_acceptor: true, state: { state_name } }))).toBe(false);
      }
    });

    it("abandon_channel is a known fnn method whose answer the hub does not read", () => {
      expect(FIBER_RPC_METHOD.ABANDON_CHANNEL).toBe("abandon_channel");
      expect(FIBER_RPC_RESULT_SCHEMAS[FIBER_RPC_METHOD.ABANDON_CHANNEL].safeParse(null).success).toBe(true);
    });
  });
});
