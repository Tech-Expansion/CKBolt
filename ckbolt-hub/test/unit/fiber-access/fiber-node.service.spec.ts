import { HttpStatus } from "@nestjs/common";
import { FiberNodeServiceImpl } from "../../../src/application/fiber-node/fiber-node.service";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { HubError } from "../../../src/common/errors/hub.error";
import type { SwapStore } from "../../../src/application/ports/swap-store.port";
import type { HubConfig } from "../../../src/config/hub.config";
import type { CkbNetwork } from "../../../src/domain/types";
import { FakeClock, FakeFiberNetwork, type FakeFiberNode } from "../../fakes";
import {
  BROWSER_NODE,
  INBOUND_CKB_AMOUNT,
  INBOUND_RUSD_AMOUNT,
  ONE_CKB,
  ONE_RUSD,
  P2P_ADDR,
  ROUTING_CHANNELS,
  RUSD_SCRIPT,
  WS_ADDR,
  WSS_ADDR,
  assetsOf,
  channelId,
  hubChannel,
  inboundConfig,
} from "./fiber-access.fixtures";

/**
 * FiberNodeService.describe (GET /v1/fiber/node): the node's id and network as the node itself reports them, the public
 * addresses from the config (never from the node), the assets the hub swaps and the inbound channels it offers.
 */

describe("FiberNodeServiceImpl.describe", () => {
  let config: HubConfig;
  let node: FakeFiberNode;
  /** No open swaps: they reserve nothing of the payout liquidity. */
  const store = { listOpenSwaps: () => [] } as unknown as SwapStore;

  const build = (nodeNetwork: CkbNetwork = "devnet", env: Record<string, string> = {}) => {
    config = inboundConfig(env);
    node = new FakeFiberNetwork(nodeNetwork, new FakeClock()).node("hub");
    node.setChannels(ROUTING_CHANNELS);
    return new FiberNodeServiceImpl(node, assetsOf(config), config, store);
  };

  it("describes the node: its id, its network, the configured addresses, the assets and the inbound offers", async () => {
    const described = await build().describe();
    expect(described.nodeId).toBe(node.nodeId);
    expect(described.network).toBe("devnet");
    expect(described.addresses).toEqual({ p2p: [P2P_ADDR], ws: [WS_ADDR, WSS_ADDR] });
    expect(described.assets.map((asset) => [asset.id, asset.udtTypeScript])).toEqual([
      ["CKB", null],
      ["RUSD", RUSD_SCRIPT],
    ]);
    expect(described.inbound.enabled).toBe(true);
    expect(described.inbound.offers.map((offer) => [offer.asset.id, offer.amount])).toEqual([
      ["CKB", INBOUND_CKB_AMOUNT],
      ["RUSD", INBOUND_RUSD_AMOUNT],
    ]);
  });

  it("reports the network the node runs on, not the one the hub is configured for", async () => {
    const described = await build("testnet").describe();
    expect(config.ckb.network).toBe("devnet");
    expect(described.network).toBe("testnet");
  });

  it("asks the node each time (no stale id or network)", async () => {
    const service = build();
    await service.describe();
    await service.describe();
    expect(node.calls.filter((call) => call === "getInfo")).toHaveLength(2);
  });

  it("hands out copies of the configured addresses, so a caller cannot change the config", async () => {
    const described = await build().describe();
    described.addresses.ws.push("/ip4/6.6.6.6/tcp/1/ws");
    described.addresses.p2p.length = 0;
    expect(config.fiberPeers.publicAddresses).toEqual({ p2p: [P2P_ADDR], ws: [WS_ADDR, WSS_ADDR] });
  });

  it("offers no inbound channel when they are off, and keeps the addresses", async () => {
    const described = await build("devnet", { FIBER_INBOUND_ENABLED: "false" }).describe();
    expect(described.inbound).toEqual({ enabled: false, offers: [] });
    expect(node.calls).not.toContain("listChannelDetails");
    expect(described.addresses.ws).toEqual([WS_ADDR, WSS_ADDR]);
  });

  it("describes empty address lists when none are configured", async () => {
    const described = await build("devnet", { FIBER_INBOUND_ENABLED: "false", FIBER_PUBLIC_P2P_ADDRS: "", FIBER_PUBLIC_WS_ADDRS: "" }).describe();
    expect(described.addresses).toEqual({ p2p: [], ws: [] });
  });

  it("answers 503 upstream_unavailable with a plain sentence when the node does not answer", async () => {
    const service = build();
    node.failNext = "getInfo";
    const error = await service.describe().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HubError);
    expect(error).toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE, code: API_ERROR_CODE.UPSTREAM_UNAVAILABLE });
    expect((error as Error).message).toMatch(/^The hub's Fiber node is not answering/);
    expect((error as Error).message).not.toMatch(/simulated transport error/);
  });

  it("passes a node's own 503 HubError through unchanged", async () => {
    const service = build();
    const unavailable = new HubError("The Fiber node is unavailable (node_info: timeout). Try again in a moment.", HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
    jest.spyOn(node, "getInfo").mockRejectedValueOnce(unavailable);
    await expect(service.describe()).rejects.toBe(unavailable);
  });

  describe("inbound offers say whether the hub can fund one now", () => {
    const fundable = async (service: FiberNodeServiceImpl) =>
      (await service.describe()).inbound.offers.map((offer) => [offer.asset.id, offer.fundable]);

    it("marks both offers fundable when the routing channels hold far more than an inbound channel", async () => {
      expect(await fundable(build())).toEqual([
        ["CKB", true],
        ["RUSD", true],
      ]);
    });

    it("marks an offer unfundable once the inbound channels already hold the payout liquidity, as POST would refuse it", async () => {
      const service = build();
      node.setChannels([
        // 800 CKB and 30 RUSD of payout liquidity: less the 25 bps fee budget, 798 CKB and 29.9 RUSD.
        hubChannel({ channelId: channelId("a1"), localBalance: 800n * ONE_CKB }),
        hubChannel({ channelId: channelId("a2"), udtTypeScript: RUSD_SCRIPT, localBalance: 30n * ONE_RUSD }),
        // A private inbound CKB channel the hub opened already holds 400 CKB: room 398 CKB < 500 CKB.
        hubChannel({ channelId: channelId("b1"), peer: BROWSER_NODE, public: false, localBalance: 400n * ONE_CKB }),
      ]);
      expect(await fundable(service)).toEqual([
        ["CKB", false],
        ["RUSD", true],
      ]);
    });

    it("leaves fundable null, and still describes the node, when its channels cannot be read", async () => {
      const service = build();
      node.failNext = "listChannelDetails";
      expect(await fundable(service)).toEqual([
        ["CKB", null],
        ["RUSD", null],
      ]);
    });
  });
});
