import type { AssetDto, FiberNodeDto, InboundChannelDto, QuoteDto } from "../../../src/interfaces/http/contract/responses";
import { API_PATH, expectApiError, lightningSideQuote, postQuote } from "../../support/hub-http";
import {
  CWBTC_CELL_DEP,
  CWBTC_MAX_SATS,
  CWBTC_SCRIPT,
  INBOUND_CKB,
  INBOUND_CWBTC,
  INBOUND_RUSD,
  P2P_ADDR,
  RUSD_CELL_DEP,
  RUSD_SCRIPT,
  takeCkbFeedsDown,
  useAssetsHubs,
  WS_ADDR,
} from "./assets.fixtures";

/**
 * A hub serving RUSD and cWBTC from FIBER_ASSETS (the VPS example), over HTTP as the web app drives it: the assets and
 * their own terms, what a browser node needs to whitelist each UDT, quotes per asset (also while the CKB price feeds are
 * down), unknown asset ids, and inbound cWBTC channels. Expected amounts are worked out by hand from the fake prices
 * (1 BTC = $80,000, 1 CKB = $0.002) and the terms: FEE_BPS 50 and OPTION_PREMIUM_BPS 50 by default, cWBTC premium 0.
 */

const PATH = {
  FIBER_NODE: "/v1/fiber/node",
  INBOUND: "/v1/fiber/inbound-channels",
  inboundOf: (nodeId: string) => `/v1/fiber/inbound-channels/${nodeId}`,
} as const;
const BROWSER_NODE = `02${"b1".repeat(32)}`;
const SATS = 10_000n;

describe("multi-asset hub over HTTP (FIBER_ASSETS: RUSD and cWBTC on testnet)", () => {
  const hubs = useAssetsHubs();

  describe("GET /v1/assets", () => {
    it("lists CKB, RUSD and cWBTC, each with its own Lightning bounds", async () => {
      const hub = await hubs.start();
      const { data } = (await hub.http().get(API_PATH.ASSETS).expect(200)).body as { data: AssetDto[] };

      expect(data.map(({ id, symbol, name, decimals, directions, minSats, maxSats }) => ({ id, symbol, name, decimals, directions, minSats, maxSats }))).toEqual([
        { id: "CKB", symbol: "CKB", name: "Nervos CKB", decimals: 8, directions: ["ln_to_fiber", "fiber_to_ln"], minSats: "1000", maxSats: "100000" },
        { id: "RUSD", symbol: "RUSD", name: "RUSD stablecoin", decimals: 8, directions: ["ln_to_fiber", "fiber_to_ln"], minSats: "1000", maxSats: "100000" },
        { id: "CWBTC", symbol: "cWBTC", name: "CCH Wrapped BTC", decimals: 8, directions: ["ln_to_fiber", "fiber_to_ln"], minSats: "1000", maxSats: CWBTC_MAX_SATS.toString() },
      ]);
    });
  });

  describe("GET /v1/fiber/node", () => {
    it("gives, per UDT, the whitelist entry a browser node needs: script, cell deps, and the auto-accept amount of the hub's inbound channel", async () => {
      const hub = await hubs.start();
      const body = (await hub.http().get(PATH.FIBER_NODE).expect(200)).body as FiberNodeDto;

      expect(body).toEqual<FiberNodeDto>({
        nodeId: hub.hubFiber.nodeId,
        network: "testnet",
        addresses: { p2p: [P2P_ADDR], ws: [WS_ADDR] },
        assets: [
          { id: "CKB", udtTypeScript: null, udtWhitelist: null, peerChannels: null },
          {
            id: "RUSD",
            udtTypeScript: RUSD_SCRIPT,
            udtWhitelist: { name: "RUSD", script: RUSD_SCRIPT, cellDeps: [RUSD_CELL_DEP], autoAcceptAmount: INBOUND_RUSD.toString() },
            peerChannels: null,
          },
          {
            id: "CWBTC",
            udtTypeScript: CWBTC_SCRIPT,
            udtWhitelist: { name: "cWBTC", script: CWBTC_SCRIPT, cellDeps: [CWBTC_CELL_DEP], autoAcceptAmount: INBOUND_CWBTC.toString() },
            peerChannels: null,
          },
        ],
        inbound: {
          enabled: true,
          amounts: { CKB: INBOUND_CKB.toString(), RUSD: INBOUND_RUSD.toString(), CWBTC: INBOUND_CWBTC.toString() },
          fundable: { CKB: true, RUSD: true, CWBTC: true },
        },
      });
    });

    it("keeps the whitelist entries but no auto-accept amount when the hub opens no inbound channels", async () => {
      const hub = await hubs.start({ FIBER_INBOUND_ENABLED: "false" });
      const body = (await hub.http().get(PATH.FIBER_NODE).expect(200)).body as FiberNodeDto;

      expect(body.assets[2]?.udtWhitelist).toEqual({ name: "cWBTC", script: CWBTC_SCRIPT, cellDeps: [CWBTC_CELL_DEP], autoAcceptAmount: null });
      expect(body.inbound).toEqual({ enabled: false, amounts: {}, fundable: {} });
    });
  });

  describe("POST /v1/quotes: each asset's own terms", () => {
    it("quotes cWBTC at BTC parity with its own premium of 0: the 50 bps hub fee only", async () => {
      const hub = await hubs.start();
      const quote = await postQuote(hub, lightningSideQuote("ln_to_fiber", "CWBTC", SATS));

      expect(quote).toMatchObject<Partial<QuoteDto>>({ asset: "CWBTC", feeBps: 50 });
      expect(quote.receive).toEqual({ network: "fiber", asset: "CWBTC", amount: "9950", decimals: 8 });
      expect(quote.prices).toMatchObject({ btcUsd: 80_000, assetUsd: 80_000, source: "median:coingecko,binance,kucoin" });
    });

    it("quotes RUSD at its $1 peg and CKB at its market price, both with the global fee and premium (100 bps)", async () => {
      const hub = await hubs.start();
      const rusd = await postQuote(hub, lightningSideQuote("ln_to_fiber", "RUSD", SATS));
      const ckb = await postQuote(hub, lightningSideQuote("ln_to_fiber", "CKB", SATS));

      expect([rusd.feeBps, rusd.receive.amount, rusd.prices.assetUsd]).toEqual([100, "792000000", 1]);
      expect([ckb.feeBps, ckb.receive.amount, ckb.prices.assetUsd]).toEqual([100, "396000000000", 0.002]);
    });

    it("holds each asset to its own Lightning cap: 30,000 sats is past cWBTC's 20,000 but fine for CKB", async () => {
      const hub = await hubs.start();
      const res = await hub.http().post(API_PATH.QUOTES).send(lightningSideQuote("ln_to_fiber", "CWBTC", 30_000n));

      expect(expectApiError(res, 422, "validation_failed")).toContain(`from 1000 to ${CWBTC_MAX_SATS} sats`);
      await postQuote(hub, lightningSideQuote("ln_to_fiber", "CKB", 30_000n));
    });

    describe("with the CKB price feeds down at every source", () => {
      it("still quotes cWBTC and RUSD, at the same amounts, in both directions", async () => {
        const hub = await hubs.start();
        takeCkbFeedsDown(hub);

        const cwbtc = await postQuote(hub, lightningSideQuote("ln_to_fiber", "CWBTC", SATS));
        const rusd = await postQuote(hub, lightningSideQuote("fiber_to_ln", "RUSD", SATS));

        expect(cwbtc.receive.amount).toBe("9950");
        expect(rusd.pay).toEqual({ network: "fiber", asset: "RUSD", amount: "808080809", decimals: 8 });
        expect(cwbtc.prices.source).toBe("median:coingecko,binance,kucoin");
      });

      it("refuses CKB quotes with 503 quote_unavailable", async () => {
        const hub = await hubs.start();
        takeCkbFeedsDown(hub);

        expectApiError(await hub.http().post(API_PATH.QUOTES).send(lightningSideQuote("ln_to_fiber", "CKB", SATS)), 503, "quote_unavailable");
      });

      it("refuses every asset once the BTC feeds are down too", async () => {
        const hub = await hubs.start();
        for (const source of hub.prices) source.failing = true;

        expectApiError(await hub.http().post(API_PATH.QUOTES).send(lightningSideQuote("ln_to_fiber", "CWBTC", SATS)), 503, "quote_unavailable");
      });
    });
  });

  describe("asset ids in requests", () => {
    it.each([
      ["POST /v1/quotes", API_PATH.QUOTES, (asset: string) => lightningSideQuote("ln_to_fiber", asset, SATS)],
      ["POST /v1/demo/invoices", API_PATH.DEMO_INVOICES, (asset: string) => ({ direction: "ln_to_fiber", asset, amount: "1000" })],
      ["POST /v1/fiber/inbound-channels", PATH.INBOUND, (asset: string) => ({ nodeId: BROWSER_NODE, asset })],
    ])("%s: a well-formed id the hub does not serve is 422 asset_unavailable; a malformed one 400 validation_failed", async (_route, path, body) => {
      const hub = await hubs.start();

      expectApiError(await hub.http().post(path).send(body("DOGE")), 422, "asset_unavailable");
      expectApiError(await hub.http().post(path).send(body("cwbtc")), 400, "validation_failed");
    });

    it("a hub without FIBER_ASSETS on testnet serves CKB and RUSD only: cWBTC is 422 asset_unavailable", async () => {
      const hub = await hubs.start({ FIBER_ASSETS: "" });

      expectApiError(await hub.http().post(API_PATH.QUOTES).send(lightningSideQuote("ln_to_fiber", "CWBTC", SATS)), 422, "asset_unavailable");
      await postQuote(hub, lightningSideQuote("ln_to_fiber", "RUSD", SATS));
    });
  });

  describe("inbound cWBTC channels", () => {
    it("opens a private cWBTC channel of the configured amount to a connected node, and lists it as CWBTC", async () => {
      const hub = await hubs.start();
      hub.hubFiber.connectPeer(BROWSER_NODE);

      const res = await hub.http().post(PATH.INBOUND).send({ nodeId: BROWSER_NODE, asset: "CWBTC" }).expect(202);

      expect(res.headers.location).toBe(PATH.inboundOf(BROWSER_NODE));
      expect(res.body).toEqual({ nodeId: BROWSER_NODE, asset: "CWBTC", fundingAmount: INBOUND_CWBTC.toString(), temporaryChannelId: expect.any(String) });
      const opened = (await hub.hubFiber.listChannelDetails(BROWSER_NODE)).filter((channel) => !channel.openedByPeer);
      expect(opened).toEqual([expect.objectContaining({ udtTypeScript: CWBTC_SCRIPT, public: false, localBalance: INBOUND_CWBTC })]);
      const { data } = (await hub.http().get(PATH.inboundOf(BROWSER_NODE)).expect(200)).body as { data: InboundChannelDto[] };
      expect(data).toEqual([expect.objectContaining({ asset: "CWBTC", state: "opening", hubBalance: INBOUND_CWBTC.toString() })]);
    });

    it("refuses a second cWBTC channel to the same node, and still opens one in another asset", async () => {
      const hub = await hubs.start();
      hub.hubFiber.connectPeer(BROWSER_NODE);
      await hub.http().post(PATH.INBOUND).send({ nodeId: BROWSER_NODE, asset: "CWBTC" }).expect(202);

      expectApiError(await hub.http().post(PATH.INBOUND).send({ nodeId: BROWSER_NODE, asset: "CWBTC" }), 409, "conflict");
      await hub.http().post(PATH.INBOUND).send({ nodeId: BROWSER_NODE, asset: "RUSD" }).expect(202);
    });

    it("refuses cWBTC when it has no inbound amount, as for any asset", async () => {
      const hub = await hubs.start({
        FIBER_ASSETS: JSON.stringify([
          { id: "CWBTC", symbol: "cWBTC", name: "CCH Wrapped BTC", decimals: 8, usdRule: "btc_parity", typeScript: CWBTC_SCRIPT, cellDeps: [CWBTC_CELL_DEP] },
        ]),
      });
      hub.hubFiber.connectPeer(BROWSER_NODE);

      expectApiError(await hub.http().post(PATH.INBOUND).send({ nodeId: BROWSER_NODE, asset: "CWBTC" }), 422, "asset_unavailable");
    });
  });
});
