import { Logger } from "@nestjs/common";
import { FiberNodeServiceImpl } from "../../../src/application/fiber-node/fiber-node.service";
import type { HubFiberNode } from "../../../src/application/fiber-node/fiber-node.contract";
import type { SwapStore } from "../../../src/application/ports/swap-store.port";
import { assetRegistryOf, type HubConfig } from "../../../src/config/hub.config";
import type { FiberNodeDto } from "../../../src/interfaces/http/contract/responses";
import { FakeClock, FakeFiberNetwork, type FakeChannel, type FakeFiberNode } from "../../fakes";
import { assetsConfig, CWBTC_ENTRY, CWBTC_SCRIPT, HUB_CHANNELS, ONE_WHOLE, RUSD_ENTRY, useAssetsHubs } from "./assets.fixtures";

/**
 * FIBER_PEER_CHANNELS_MAX_OPEN on GET /v1/fiber/node (FiberNodeServiceImpl.describe and its DTO): the hub offers peer
 * channels (FIBER_ASSETS peerChannels) only while nodes have opened fewer such channels to its fnn than the cap, and
 * offers none when it cannot read the node's channels; the rest of the description never changes with the cap. The
 * inbound offers and the cap share one channel listing per request.
 *
 * The node-opened channels here are ready, so they count whatever rule decides about channels still being opened.
 */

const MAX_OPEN = "FIBER_PEER_CHANNELS_MAX_OPEN";
/** 5 cWBTC: the least funding fnn-hub accepts on its own for a cWBTC channel a node opens. */
const MIN_PEER_CWBTC = 5n * ONE_WHOLE;
const CWBTC_WITH_PEERS = { ...CWBTC_ENTRY, peerChannels: { minAmount: MIN_PEER_CWBTC.toString() } };
const PEER_CHANNELS_ON = { FIBER_ASSETS: JSON.stringify([RUSD_ENTRY, CWBTC_WITH_PEERS]) };

/** A ready private cWBTC channel node `n` opened to the hub with its own tokens. */
const nodeOpenedCwbtc = (n: number): FakeChannel => ({
  channelId: `0x${n.toString(16).padStart(2, "0").repeat(32)}`,
  peer: `03${n.toString(16).padStart(2, "0").repeat(32)}`,
  udtTypeScript: CWBTC_SCRIPT,
  ready: true,
  localBalance: 0n,
  remoteBalance: MIN_PEER_CWBTC,
  public: false,
  openedByPeer: true,
});
const nodeOpened = (count: number): FakeChannel[] => Array.from({ length: count }, (_, i) => nodeOpenedCwbtc(i + 1));

/** No open swaps: they reserve nothing of the payout liquidity. */
const NO_SWAPS = { listOpenSwaps: () => [] } as unknown as SwapStore;

interface Described {
  node: FakeFiberNode;
  config: HubConfig;
  described: HubFiberNode;
}

describe("GET /v1/fiber/node: FIBER_PEER_CHANNELS_MAX_OPEN", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  function service(env: Record<string, string>, channels: FakeChannel[]): { node: FakeFiberNode; config: HubConfig; service: FiberNodeServiceImpl } {
    const config = assetsConfig(env);
    const node = new FakeFiberNetwork(config.ckb.network, new FakeClock()).node("hub");
    node.setChannels(channels);
    return { node, config, service: new FiberNodeServiceImpl(node, assetRegistryOf(config), config, NO_SWAPS) };
  }

  async function describeWith(env: Record<string, string>, channels: FakeChannel[] = HUB_CHANNELS): Promise<Described> {
    const built = service(env, channels);
    return { node: built.node, config: built.config, described: await built.service.describe() };
  }

  const offeredAssets = ({ described }: Described): string[] => described.peerChannels.map((offer) => offer.asset.id);

  describe("FiberNodeServiceImpl.describe", () => {
    it("offers the peer channels while nodes have opened fewer such channels than the cap", async () => {
      const result = await describeWith({ ...PEER_CHANNELS_ON, [MAX_OPEN]: "3" }, [...HUB_CHANNELS, ...nodeOpened(2)]);

      expect(result.described.peerChannels).toEqual([
        { asset: expect.objectContaining({ id: "CWBTC" }), minAmount: MIN_PEER_CWBTC, assumedCommitmentDelayEpochs: 84 },
      ]);
    });

    it("offers none once nodes have opened as many as the cap, and none past it", async () => {
      expect(offeredAssets(await describeWith({ ...PEER_CHANNELS_ON, [MAX_OPEN]: "2" }, [...HUB_CHANNELS, ...nodeOpened(2)]))).toEqual([]);
      expect(offeredAssets(await describeWith({ ...PEER_CHANNELS_ON, [MAX_OPEN]: "2" }, [...HUB_CHANNELS, ...nodeOpened(3)]))).toEqual([]);
    });

    it("changes nothing else in the description at the cap", async () => {
      const channels = [...HUB_CHANNELS, ...nodeOpened(2)];
      const under = await describeWith({ ...PEER_CHANNELS_ON, [MAX_OPEN]: "3" }, channels);
      const at = await describeWith({ ...PEER_CHANNELS_ON, [MAX_OPEN]: "2" }, channels);

      expect(under.described.peerChannels).not.toEqual([]);
      expect(at.described).toEqual({ ...under.described, peerChannels: [] });
    });

    it("offers none with the cap at 0, even before any node has opened one", async () => {
      expect(offeredAssets(await describeWith({ ...PEER_CHANNELS_ON, [MAX_OPEN]: "0" }))).toEqual([]);
    });

    describe("when the node's channels cannot be read (list_channels fails)", () => {
      async function failingListing(env: Record<string, string> = PEER_CHANNELS_ON): Promise<HubFiberNode> {
        const built = service(env, HUB_CHANNELS);
        built.node.failNext = "listChannelDetails";
        return built.service.describe();
      }

      it("still describes the node, with every inbound offer's funding unknown and no peer channels", async () => {
        const healthy = (await describeWith(PEER_CHANNELS_ON)).described;
        const described = await failingListing();

        expect(healthy.peerChannels).toHaveLength(1);
        expect(described.peerChannels).toEqual([]);
        expect(described.inbound.offers.map((offer) => [offer.asset.id, offer.fundable])).toEqual([
          ["CKB", null],
          ["RUSD", null],
          ["CWBTC", null],
        ]);
        expect(described).toEqual({
          ...healthy,
          inbound: { ...healthy.inbound, offers: healthy.inbound.offers.map((offer) => ({ ...offer, fundable: null })) },
          peerChannels: [],
        });
      });

      it("logs a warning that names the listing and the failure", async () => {
        await failingListing();

        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0]?.[0]);
        expect(message).toMatch(/channels/i);
        expect(message).toMatch(/peer channels/);
        expect(message).toContain("simulated transport error");
      });

      it("logs nothing when the listing works", async () => {
        await describeWith(PEER_CHANNELS_ON);
        expect(warn).not.toHaveBeenCalled();
      });
    });

    describe("one channel listing per request", () => {
      const listings = (node: FakeFiberNode): number => node.calls.filter((call) => call === "listChannelDetails").length;

      it("reads the channels exactly once when there are both inbound offers and peer channel terms", async () => {
        const result = await describeWith(PEER_CHANNELS_ON);

        expect(result.described.inbound.offers.length).toBeGreaterThan(0);
        expect(result.config.fiberPeers.peerChannels.terms).not.toEqual({});
        expect(listings(result.node)).toBe(1);
      });

      it("reads them once a request, every request", async () => {
        const built = service(PEER_CHANNELS_ON, HUB_CHANNELS);
        await built.service.describe();
        await built.service.describe();

        expect(listings(built.node)).toBe(2);
      });

      it("reads them once as well for peer channel terms alone (inbound channels off)", async () => {
        const result = await describeWith({ ...PEER_CHANNELS_ON, FIBER_INBOUND_ENABLED: "false" });

        expect(result.described.inbound.offers).toEqual([]);
        expect(listings(result.node)).toBe(1);
      });

      it("does not read them at all with neither inbound offers nor peer channel terms", async () => {
        const result = await describeWith({ FIBER_INBOUND_ENABLED: "false" });

        expect(result.config.fiberPeers.peerChannels.terms).toEqual({});
        expect(result.described).toMatchObject({ inbound: { enabled: false, offers: [] }, peerChannels: [] });
        expect(listings(result.node)).toBe(0);
      });
    });
  });

  describe("over HTTP (the real AppModule on fakes)", () => {
    const hubs = useAssetsHubs();
    const PATH = "/v1/fiber/node";

    const body = async (env: Record<string, string>, channels: FakeChannel[]): Promise<FiberNodeDto> => {
      const hub = await hubs.start(env, channels);
      return (await hub.http().get(PATH).expect(200)).body as FiberNodeDto;
    };
    const withoutPeerChannels = (dto: FiberNodeDto): FiberNodeDto => ({ ...dto, assets: dto.assets.map((asset) => ({ ...asset, peerChannels: null })) });

    it("gives every asset peerChannels null at the cap, the rest of the body as under it", async () => {
      const channels = [...HUB_CHANNELS, ...nodeOpened(2)];
      const under = await body({ ...PEER_CHANNELS_ON, [MAX_OPEN]: "3" }, channels);
      const at = await body({ ...PEER_CHANNELS_ON, [MAX_OPEN]: "2" }, channels);

      expect(under.assets.find((asset) => asset.id === "CWBTC")?.peerChannels).toEqual({ minAmount: MIN_PEER_CWBTC.toString(), assumedCommitmentDelayEpochs: 84 });
      expect(at.assets.map((asset) => asset.peerChannels)).toEqual([null, null, null]);
      expect(at).toEqual(withoutPeerChannels(under));
    });

    it("answers 200 when list_channels fails: peerChannels null for every asset and no inbound offer marked fundable", async () => {
      const healthy = await body(PEER_CHANNELS_ON, HUB_CHANNELS);
      const hub = await hubs.start(PEER_CHANNELS_ON, HUB_CHANNELS);
      hub.hubFiber.failNext = "listChannelDetails";
      const failed = (await hub.http().get(PATH).expect(200)).body as FiberNodeDto;

      expect(failed.assets.map((asset) => asset.peerChannels)).toEqual([null, null, null]);
      expect(failed.inbound.fundable).toEqual({});
      expect(failed.inbound.amounts).toEqual(healthy.inbound.amounts);
      expect(failed).toEqual({ ...withoutPeerChannels(healthy), inbound: { ...healthy.inbound, fundable: {} } });
    });
  });
});
