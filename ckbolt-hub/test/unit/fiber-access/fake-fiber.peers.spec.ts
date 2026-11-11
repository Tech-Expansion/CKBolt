import { HttpStatus } from "@nestjs/common";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { HubError } from "../../../src/common/errors/hub.error";
import { FakeClock, FakeFiberNetwork, type FakeFiberNode } from "../../fakes";
import { BROWSER_NODE, INBOUND_CKB_AMOUNT, RUSD_SCRIPT, SECOND_NODE, asTyped, channelId, hubChannel } from "./fiber-access.fixtures";

/**
 * FakeFiberNode's peers and channel opening behave like fnn v0.9.1 where the inbound channel rules depend on it:
 * open_channel needs a connected peer and otherwise answers with an fnn error (a plain Error, nothing opened); a new
 * channel is opening with the whole funding on the opener's side; a lost answer is a 503 with the channel opening.
 */

describe("FakeFiberNode: peers and opened channels (fnn parity)", () => {
  let node: FakeFiberNode;

  beforeEach(() => {
    node = new FakeFiberNetwork("devnet", new FakeClock()).node("hub");
    node.setChannels([]);
  });

  it("reports the network of its fake network as its own", async () => {
    await expect(new FakeFiberNetwork("testnet", new FakeClock()).node("x").getInfo()).resolves.toMatchObject({ network: "testnet" });
  });

  it("is connected only to the nodes that dialled it, whatever the id's spelling", async () => {
    await expect(node.isConnected(BROWSER_NODE)).resolves.toBe(false);
    node.connectPeer(asTyped(BROWSER_NODE));
    await expect(node.isConnected(BROWSER_NODE)).resolves.toBe(true);
    await expect(node.isConnected(SECOND_NODE)).resolves.toBe(false);
    node.disconnectPeer(BROWSER_NODE);
    await expect(node.isConnected(BROWSER_NODE)).resolves.toBe(false);
  });

  it("refuses to open a channel to a node that is not connected with a plain Error, and opens nothing", async () => {
    const error = await node.openChannel({ peer: BROWSER_NODE, fundingAmount: INBOUND_CKB_AMOUNT, udtTypeScript: null, public: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HubError);
    await expect(node.listChannelDetails()).resolves.toEqual([]);
  });

  it("opens a channel as asked: opening, private or public, opened by itself, the whole funding on its side", async () => {
    node.connectPeer(BROWSER_NODE);
    const { temporaryChannelId } = await node.openChannel({ peer: asTyped(BROWSER_NODE), fundingAmount: INBOUND_CKB_AMOUNT, udtTypeScript: RUSD_SCRIPT, public: false });
    expect(await node.listChannelDetails(BROWSER_NODE)).toEqual([
      {
        channelId: temporaryChannelId,
        peer: BROWSER_NODE,
        udtTypeScript: RUSD_SCRIPT,
        ready: false,
        localBalance: INBOUND_CKB_AMOUNT,
        remoteBalance: 0n,
        status: "opening",
        public: false,
        openedByPeer: false,
        // The peer has not accepted it yet (stale-inbound-opens.ts): when the hub asked.
        awaitingAcceptSince: expect.any(Number),
      },
    ]);
    expect(await node.listChannels()).toEqual([
      { channelId: temporaryChannelId, peer: BROWSER_NODE, udtTypeScript: RUSD_SCRIPT, ready: false, localBalance: INBOUND_CKB_AMOUNT, remoteBalance: 0n },
    ]);
  });

  it("gives every opened channel its own temporary id", async () => {
    node.connectPeer(BROWSER_NODE);
    node.connectPeer(SECOND_NODE);
    const first = await node.openChannel({ peer: BROWSER_NODE, fundingAmount: 1n, udtTypeScript: null, public: false });
    const second = await node.openChannel({ peer: SECOND_NODE, fundingAmount: 1n, udtTypeScript: null, public: false });
    expect(first.temporaryChannelId).not.toBe(second.temporaryChannelId);
  });

  it("makes every opening channel ready once its peer accepts (completeChannelOpenings)", async () => {
    node.connectPeer(BROWSER_NODE);
    await node.openChannel({ peer: BROWSER_NODE, fundingAmount: 1n, udtTypeScript: null, public: false });
    node.completeChannelOpenings();
    await expect(node.listChannelDetails(BROWSER_NODE)).resolves.toMatchObject([{ status: "ready", ready: true }]);
  });

  it("plays a lost open_channel answer: a 503 HubError while the channel is opening", async () => {
    node.connectPeer(BROWSER_NODE);
    node.loseNextOpenChannelAnswer = true;
    const error = await node.openChannel({ peer: BROWSER_NODE, fundingAmount: 1n, udtTypeScript: null, public: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HubError);
    expect(error).toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE, code: API_ERROR_CODE.UPSTREAM_UNAVAILABLE });
    await expect(node.listChannelDetails(BROWSER_NODE)).resolves.toMatchObject([{ status: "opening" }]);
    await expect(node.openChannel({ peer: BROWSER_NODE, fundingAmount: 1n, udtTypeScript: null, public: false })).resolves.toBeDefined();
  });

  it("filters channels by peer and fills in a channel's status and opener from setChannels", async () => {
    node.setChannels([
      { channelId: channelId("e1"), peer: BROWSER_NODE, udtTypeScript: null, ready: true, localBalance: 1n, remoteBalance: 2n },
      hubChannel({ channelId: channelId("e2"), peer: SECOND_NODE, status: "closing", public: false, openedByPeer: true }),
    ]);
    await expect(node.listChannelDetails(BROWSER_NODE)).resolves.toEqual([
      { channelId: channelId("e1"), peer: BROWSER_NODE, udtTypeScript: null, ready: true, localBalance: 1n, remoteBalance: 2n, status: "ready", public: true, openedByPeer: false },
    ]);
    await expect(node.listChannelDetails(SECOND_NODE)).resolves.toMatchObject([{ status: "closing", public: false, openedByPeer: true }]);
    await expect(node.listChannelDetails()).resolves.toHaveLength(2);
  });

  it("hands out copies: changing a listed channel does not change the node", async () => {
    node.setChannels([hubChannel({ channelId: channelId("e1"), peer: BROWSER_NODE, localBalance: 5n })]);
    const [listed] = await node.listChannelDetails();
    if (listed) listed.localBalance = 0n;
    await expect(node.listChannelDetails()).resolves.toMatchObject([{ localBalance: 5n }]);
  });

  it("fails the next call of a method on failNext, as a transport error", async () => {
    node.failNext = "isConnected";
    await expect(node.isConnected(BROWSER_NODE)).rejects.toThrow(/simulated transport error/);
    await expect(node.isConnected(BROWSER_NODE)).resolves.toBe(false);
  });
});
