import { inboundOffers } from "../../../src/application/fiber-node/inbound-channel.rules";
import { assetRegistryOf } from "../../../src/config/hub.config";
import { assetsConfig, INBOUND_CKB, INBOUND_CWBTC, INBOUND_RUSD } from "./assets.fixtures";

/** inboundOffers: what the hub funds an inbound channel with per asset, and what a browser node auto-accepts it at. */
describe("inboundOffers with FIBER_ASSETS", () => {
  it("offers CKB, RUSD and cWBTC in the registry's order; UDTs carry their auto-accept amount, CKB none", () => {
    const config = assetsConfig();

    expect(inboundOffers(config.fiberPeers.inboundChannels, assetRegistryOf(config)).map(({ asset, amount, autoAcceptAmount }) => [asset.id, amount, autoAcceptAmount])).toEqual([
      ["CKB", INBOUND_CKB, null],
      ["RUSD", INBOUND_RUSD, INBOUND_RUSD],
      ["CWBTC", INBOUND_CWBTC, INBOUND_CWBTC],
    ]);
  });

  it("falls back to the amount itself for a UDT whose auto-accept amount is not given", () => {
    const config = assetsConfig();
    const settings = { ...config.fiberPeers.inboundChannels, autoAcceptAmounts: {} };

    expect(inboundOffers(settings, assetRegistryOf(config)).find((offer) => offer.asset.id === "CWBTC")?.autoAcceptAmount).toBe(INBOUND_CWBTC);
  });

  it("offers nothing when inbound channels are off", () => {
    const config = assetsConfig({ FIBER_INBOUND_ENABLED: "false" });

    expect(inboundOffers(config.fiberPeers.inboundChannels, assetRegistryOf(config))).toEqual([]);
  });
});
