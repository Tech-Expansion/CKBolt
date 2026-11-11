import { canFundInbound, inboundFundingRoom, paysOnlyItsPeer } from "../../../src/application/fiber-node/inbound-channel.rules";
import { isNodeOpenedPeerChannel, nodeOpenedPeerChannelCount, peerChannelOffers } from "../../../src/application/fiber-node/peer-channel.rules";
import type { FiberChannel } from "../../../src/application/ports/fiber.port";
import { FIBER_CHANNEL_STATUS } from "../../../src/common/constants/fiber-node.constants";
import { MS_PER_HOUR, MS_PER_MINUTE } from "../../../src/common/constants/protocol.constants";
import { SWAP_STATE } from "../../../src/common/constants/swap.constants";
import { TIMING_PROFILES } from "../../../src/common/constants/timing.constants";
import { assetRegistryOf, type PeerChannelsConfig } from "../../../src/config/hub.config";
import type { PayoutReservation } from "../../../src/domain/pricing";
import { fiberHoldReserveMs } from "../../../src/domain/timing/timing.budget";
import { planFiberToLn } from "../../../src/domain/timing/timing.policy";
import type { TimingProfile } from "../../../src/domain/timing/timing.types";
import type { FiberAsset } from "../../../src/domain/types";
import { assetsConfig, CWBTC_ENTRY, CWBTC_SCRIPT, RUSD_SCRIPT } from "./assets.fixtures";

/**
 * The pure rules behind peer channels: which UDTs the hub offers them in, why a channel a node opened privately is not
 * payout liquidity for inbound channels (it pays only its own node), and the fiber_to_ln hold sized for the longest
 * commitment delay an opener may choose. Expected numbers are worked out by hand in the comments.
 */

const minutes = (n: number): number => n * MS_PER_MINUTE;
const hours = (n: number): number => n * MS_PER_HOUR;

const registry = assetRegistryOf(assetsConfig());
const asset = (id: string): FiberAsset => {
  const found = registry.get(id);
  if (!found) throw new Error(`test setup: ${id} is not served`);
  return found;
};

describe("peerChannelOffers", () => {
  it("lists the UDTs that take peer channels in the registry's order, not the order of the terms", () => {
    const settings: PeerChannelsConfig = { terms: { CWBTC: { minAmount: 500n }, RUSD: { minAmount: 7n } }, maxOpen: 10 };

    expect(peerChannelOffers(settings, registry, 84).map(({ asset: { id }, minAmount, assumedCommitmentDelayEpochs }) => [id, minAmount, assumedCommitmentDelayEpochs])).toEqual([
      ["RUSD", 7n, 84],
      ["CWBTC", 500n, 84],
    ]);
  });

  it("gives the whole asset as the registry has it", () => {
    const [offer] = peerChannelOffers({ terms: { CWBTC: { minAmount: 500n } } }, registry, 84);

    expect(offer).toEqual({ asset: asset("CWBTC"), minAmount: 500n, assumedCommitmentDelayEpochs: 84 });
  });

  it("leaves out terms for an asset the hub does not serve", () => {
    expect(peerChannelOffers({ terms: { TUSD: { minAmount: 1n } } }, registry, 84)).toEqual([]);
  });

  it("offers nothing without terms", () => {
    expect(peerChannelOffers({ terms: {} }, registry, 84)).toEqual([]);
  });

  it("passes on the commitment delay it is given", () => {
    expect(peerChannelOffers({ terms: { CWBTC: { minAmount: 1n } } }, registry, 12)[0]?.assumedCommitmentDelayEpochs).toBe(12);
  });
});

/* --------------------------------------------------------------------------------------------- channels */

let channelCount = 0;
/** A channel of the hub's fnn; by default the hub's own public channel, ready. */
const channel = (patch: Partial<FiberChannel>): FiberChannel => {
  channelCount += 1;
  return {
    channelId: `0x${channelCount.toString(16).padStart(64, "0")}`,
    peer: `03${"cd".repeat(32)}`,
    udtTypeScript: CWBTC_SCRIPT,
    ready: true,
    localBalance: 0n,
    remoteBalance: 0n,
    status: FIBER_CHANNEL_STATUS.READY,
    public: true,
    openedByPeer: false,
    ...patch,
  };
};

describe("isNodeOpenedPeerChannel: what takes a reserve under FIBER_PEER_CHANNELS_MAX_OPEN", () => {
  const config = assetsConfig({
    FIBER_ASSETS: JSON.stringify([
      { ...CWBTC_ENTRY, peerChannels: { minAmount: "1000000" } },
    ]),
  });
  const settings = config.fiberPeers.peerChannels;
  const assets = assetRegistryOf(config);
  const opening = { public: false, openedByPeer: true, ready: false, status: FIBER_CHANNEL_STATUS.OPENING };

  it("leaves out a channel still negotiating its funding, such as an open request fnn-hub has not accepted", () => {
    expect(isNodeOpenedPeerChannel(channel({ ...opening, negotiating: true }), settings, assets)).toBe(false);
  });

  it("counts a node-opened channel from the funding on: opening past the negotiation, ready, closing", () => {
    expect(isNodeOpenedPeerChannel(channel(opening), settings, assets)).toBe(true);
    expect(isNodeOpenedPeerChannel(channel({ public: false, openedByPeer: true }), settings, assets)).toBe(true);
    expect(isNodeOpenedPeerChannel(channel({ ...opening, status: FIBER_CHANNEL_STATUS.CLOSING }), settings, assets)).toBe(true);
  });

  it("does not let cheap requests fill the cap: ten negotiating requests and one funded channel count as one", () => {
    const requests = Array.from({ length: 10 }, () => channel({ ...opening, negotiating: true }));
    expect(nodeOpenedPeerChannelCount([...requests, channel(opening)], settings, assets)).toBe(1);
  });
});

describe("paysOnlyItsPeer", () => {
  it.each([
    ["a private channel a node opened to the hub (peer channel)", { public: false, openedByPeer: true }, true],
    ["a private channel the hub opened (an inbound channel)", { public: false, openedByPeer: false }, true],
    ["a private peer channel still opening", { public: false, openedByPeer: true, ready: false, status: FIBER_CHANNEL_STATUS.OPENING }, true],
    ["a private peer channel closing", { public: false, openedByPeer: true, ready: false, status: FIBER_CHANNEL_STATUS.CLOSING }, true],
    ["a public channel a node opened to the hub", { public: true, openedByPeer: true }, false],
    ["the hub's own public channel", { public: true, openedByPeer: false }, false],
    ["a closed private channel (not live)", { public: false, openedByPeer: true, ready: false, status: FIBER_CHANNEL_STATUS.CLOSED }, false],
  ] as const)("%s: %s", (_label, patch, expected) => {
    expect(paysOnlyItsPeer(channel(patch))).toBe(expected);
  });
});

describe("inboundFundingRoom: private channels nodes opened are not payout liquidity", () => {
  const CWBTC = asset("CWBTC");
  // The hub's channels in cWBTC (base units), and one in RUSD:
  const routing = channel({ localBalance: 1_000n }); // the hub's own public channel: counts
  const peerPrivate = channel({ localBalance: 500n, public: false, openedByPeer: true }); // a peer channel the hub was paid over: pays only that node
  const peerPublic = channel({ localBalance: 300n, public: true, openedByPeer: true }); // a public channel a node opened: routes, counts
  const inboundReady = channel({ localBalance: 200n, public: false }); // the hub's inbound channel: not liquidity, and already given
  const inboundOpening = channel({ localBalance: 100n, public: false, ready: false, status: FIBER_CHANNEL_STATUS.OPENING }); // already given
  const peerPrivateRusd = channel({ localBalance: 999n, public: false, openedByPeer: true, udtTypeScript: RUSD_SCRIPT }); // another asset
  const peerClosed = channel({ localBalance: 700n, public: false, openedByPeer: true, ready: false, status: FIBER_CHANNEL_STATUS.CLOSED }); // gone
  const all = [routing, peerPrivate, peerPublic, inboundReady, inboundOpening, peerPrivateRusd, peerClosed];

  it("counts the public channels only, less what inbound channels hold (no fee budget)", () => {
    // (1,000 + 300) - (200 + 100) = 1,000. Counting the private peer channel would give 1,500.
    expect(inboundFundingRoom(all, [], CWBTC, 0)).toBe(1_000n);
  });

  it("leaves room for the payout's fee budget on what it counts", () => {
    // floor(1,300 x 10,000 / 10,025) = floor(1,296.76) = 1,296; less 300 in inbound channels = 996.
    expect(inboundFundingRoom(all, [], CWBTC, 25)).toBe(996n);
  });

  it("takes off what open ln_to_fiber swaps in the asset still need, and nothing for other swaps", () => {
    const openSwaps: PayoutReservation[] = [
      { direction: "ln_to_fiber", asset: "CWBTC", state: SWAP_STATE.PENDING, sats: 100n, fiberAmount: 100n },
      { direction: "fiber_to_ln", asset: "CWBTC", state: SWAP_STATE.PENDING, sats: 400n, fiberAmount: 400n },
      { direction: "ln_to_fiber", asset: "RUSD", state: SWAP_STATE.PENDING, sats: 400n, fiberAmount: 400n },
    ];
    // (1,300 - 100) - 300 = 900.
    expect(inboundFundingRoom(all, openSwaps, CWBTC, 0)).toBe(900n);
  });

  it("finds no room when the hub's only cWBTC balance is in a private channel a node opened", () => {
    // Nothing counts; the inbound channel's 200 already given makes it negative.
    expect(inboundFundingRoom([peerPrivate, inboundReady], [], CWBTC, 0)).toBe(-200n);
    expect(inboundFundingRoom([peerPrivate], [], CWBTC, 0)).toBe(0n);
  });

  it("still counts a peer's public channel on its own", () => {
    expect(inboundFundingRoom([peerPublic], [], CWBTC, 0)).toBe(300n);
  });

  it("funds an offer only within that room (canFundInbound)", () => {
    const offer = (amount: bigint) => ({ asset: CWBTC, amount, autoAcceptAmount: amount });

    expect(canFundInbound(all, [], offer(1_000n), 0)).toBe(true);
    expect(canFundInbound(all, [], offer(1_001n), 0)).toBe(false);
    expect(canFundInbound([peerPrivate], [], offer(1n), 0)).toBe(false);
  });
});

/* ----------------------------------------------------------------------------------------------- timing */

describe("planFiberToLn: the hold sized for the inbound channel's commitment delay", () => {
  const SIX_HOURS = hours(6);
  const plan = (profile: TimingProfile, payoutCltvExpiry: number, inboundCommitmentDelayEpochs?: number) =>
    planFiberToLn(
      profile,
      inboundCommitmentDelayEpochs === undefined
        ? { payoutCltvExpiry, configuredHoldFinalExpiryDeltaMs: SIX_HOURS }
        : { payoutCltvExpiry, configuredHoldFinalExpiryDeltaMs: SIX_HOURS, inboundCommitmentDelayEpochs },
    );

  describe("regtest (slow block 15 min, route 80 blocks, margin 10 min), CLTV-40 payout invoice", () => {
    // Payout window: (40 + 3 padding + 1 + 80 route) = 124 blocks x 15 min = 1,860 min (31 h).
    it("omitted: fnn's default of 1 epoch, as before (160 min + 60 s early fail + 10 min margin)", () => {
      // 1,860 + 160 + 1 + 10 = 2,031 min = 121,860,000 ms.
      expect(plan(TIMING_PROFILES.regtest, 40)).toEqual({ ok: true, holdFinalExpiryDeltaMs: 121_860_000 });
    });

    it("1 epoch given: the same as omitted", () => {
      expect(plan(TIMING_PROFILES.regtest, 40, 1)).toEqual({ ok: true, holdFinalExpiryDeltaMs: minutes(2_031) });
    });

    it("2 epochs: 2 x 4 h x 2/3 = 320 min of early fail", () => {
      // 1,860 + 320 + 1 + 10 = 2,191 min = 131,460,000 ms.
      expect(plan(TIMING_PROFILES.regtest, 40, 2)).toEqual({ ok: true, holdFinalExpiryDeltaMs: 131_460_000 });
    });

    it("84 epochs: 84 x 4 h x 2/3 = 224 h of early fail", () => {
      // 1,860 min + 224 h (13,440 min) + 1 + 10 = 15,311 min = 255 h 11 min = 918,660,000 ms.
      expect(plan(TIMING_PROFILES.regtest, 40, 84)).toEqual({ ok: true, holdFinalExpiryDeltaMs: 918_660_000 });
    });
  });

  it("regtest, CLTV-80 invoice: 2,631 min by default, 265 h 11 min for 84 epochs", () => {
    // (80 + 3 + 1 + 80) = 164 blocks x 15 min = 2,460 min. Default: + 171 = 2,631 min. 84: + 13,451 = 15,911 min.
    expect(plan(TIMING_PROFILES.regtest, 80)).toEqual({ ok: true, holdFinalExpiryDeltaMs: minutes(2_631) });
    expect(plan(TIMING_PROFILES.regtest, 80, 84)).toEqual({ ok: true, holdFinalExpiryDeltaMs: 954_660_000 });
  });

  it("mutinynet, CLTV-80 invoice: the configured 6 h by default, 227 h 14 min for 84 epochs", () => {
    // (80 + 3 + 1 + 160) = 244 blocks x 45 s = 183 min. Default: 183 + 171 = 354 min < 360 min, so 6 h.
    // 84: 183 + 13,440 + 1 + 10 = 13,634 min = 818,040,000 ms.
    expect(plan(TIMING_PROFILES.mutinynet, 80)).toEqual({ ok: true, holdFinalExpiryDeltaMs: SIX_HOURS });
    expect(plan(TIMING_PROFILES.mutinynet, 80, 84)).toEqual({ ok: true, holdFinalExpiryDeltaMs: 818_040_000 });
  });

  it("testnet (margin 15 min, route 160 blocks), CLTV-40 invoice: 84 epochs adds 224 h to the payout window", () => {
    // (40 + 3 + 1 + 160) = 204 blocks x 15 min = 3,060 min. 84: 3,060 + 13,440 + 1 + 15 = 16,516 min = 990,960,000 ms.
    expect(plan(TIMING_PROFILES.testnet, 40, 84)).toEqual({ ok: true, holdFinalExpiryDeltaMs: 990_960_000 });
  });

  describe("Fiber's 14-day maximum (20,160 min)", () => {
    // A regtest profile with a far longer payout allowed: CLTV 40 + 3 + 1 + route budget, at 15 min a block.
    const longPayouts = (lnRouteBudgetBlocks: number): TimingProfile => ({
      ...TIMING_PROFILES.regtest,
      name: "regtest-long-payouts",
      lnRouteBudgetBlocks,
      maxPayoutLockMs: hours(120),
    });

    it("fails a payout window the default delay fits but 84 epochs push past 14 days", () => {
      // 44 + 404 = 448 blocks x 15 min = 6,720 min (112 h). Default: 6,720 + 171 = 6,891 min.
      // 84: 6,720 + 13,451 = 20,171 min > 20,160 min.
      expect(plan(longPayouts(404), 40)).toEqual({ ok: true, holdFinalExpiryDeltaMs: minutes(6_891) });
      const refused = plan(longPayouts(404), 40, 84);
      expect(refused.ok).toBe(false);
      expect(refused.ok ? null : refused.reason).toMatch(/final expiry delta of 20171 minutes, above Fiber's maximum of 20160 minutes/);
    });

    it("takes one block less: 447 blocks x 15 min = 6,705 min + 13,451 = 20,156 min", () => {
      expect(plan(longPayouts(403), 40, 84)).toEqual({ ok: true, holdFinalExpiryDeltaMs: minutes(20_156) });
    });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("refuses %p epochs as an invalid input, naming it", (epochs) => {
    expect(plan(TIMING_PROFILES.regtest, 40, epochs)).toEqual({
      ok: false,
      reason: "The timing input inboundCommitmentDelayEpochs must be a finite number that is not negative.",
    });
  });
});

describe("fiberHoldReserveMs", () => {
  it("is fnn's early fail for the delay (2/3 of epochs x 4 h, plus 60 s) plus the profile's margin", () => {
    // Default: 160 min + 1 + 10 = 171 min. 84 epochs: 13,440 + 1 + 10 = 13,451 min. Testnet's margin is 15 min.
    expect(fiberHoldReserveMs(TIMING_PROFILES.regtest)).toBe(minutes(171));
    expect(fiberHoldReserveMs(TIMING_PROFILES.regtest, 1)).toBe(minutes(171));
    expect(fiberHoldReserveMs(TIMING_PROFILES.regtest, 84)).toBe(807_060_000);
    expect(fiberHoldReserveMs(TIMING_PROFILES.testnet, 84)).toBe(minutes(13_456));
  });
});
