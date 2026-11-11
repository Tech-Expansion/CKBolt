import { createHash } from "node:crypto";
import { SwapSchedulerService } from "../../../src/application/swaps/swap-scheduler.service";
import { MS_PER_HOUR, MS_PER_MINUTE } from "../../../src/common/constants/protocol.constants";
import { SWAP_REASON } from "../../../src/domain/swap";
import type { FiberAssetId, Hex32 } from "../../../src/domain/types";
import type { FiberNodeDto, SwapDto } from "../../../src/interfaces/http/contract/responses";
import type { FakeChannel } from "../../fakes";
import { API_PATH, createSwap, expectApiError, getSwap, lightningSideQuote, postDemoInvoice, postDemoPayment, postQuote } from "../../support/hub-http";
import {
  CWBTC_CELL_DEP,
  CWBTC_ENTRY,
  CWBTC_SCRIPT,
  HUB_CHANNELS,
  INBOUND_CWBTC,
  INBOUND_RUSD,
  ONE_WHOLE,
  processUntilFinished,
  RUSD_CELL_DEP,
  RUSD_ENTRY,
  RUSD_SCRIPT,
  useAssetsHubs,
  type AssetsHub,
} from "./assets.fixtures";

/**
 * Peer channels over HTTP on fake nodes: a node may open its own cWBTC channel to the hub (FIBER_ASSETS peerChannels),
 * so the hub sizes cWBTC fiber_to_ln hold invoices for the longest commitment delay such an opener may choose (84
 * epochs, which fnn does not report), and refunds a payment that came over a payer's own channel in an asset without
 * peer channels when its hold is too short for that delay.
 *
 * Numbers (the harness's regtest profile: slow block 15 min, Lightning route budget 80 blocks, Fiber margin 10 min, payout
 * lock cap 48 h; the demo wallet's Lightning payout invoice has CLTV 40; FIBER_HOLD_FINAL_EXPIRY_DELTA_MINUTES 360):
 * - payout window: (40 + 3 LND padding + 1 + 80 route) = 124 blocks x 15 min = 1,860 min (31 h);
 * - hold for fnn's default 1-epoch channel: 1,860 + 160 (2/3 x 4 h) + 1 (fnn's check interval) + 10 = 2,031 min;
 * - hold for an 84-epoch channel: 1,860 + 13,440 (2/3 x 84 x 4 h = 224 h) + 1 + 10 = 15,311 min (255 h 11 min);
 * - the payer's TLC expires one hop delta (4 h) after the invoice's final delta: 2,271 min, or 15,551 min (259 h 11 min);
 * - fnn adds a TLC only when its expiry is at least 2/3 of its channel's delay away: 224 h for 84 epochs, 320 min for 2.
 */

const SATS = 10_000n;
const minutes = (n: number): number => n * MS_PER_MINUTE;
const hours = (n: number): number => n * MS_PER_HOUR;
const sha256 = (hex: Hex32): Hex32 => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");

/** 2,031 min: the hold invoice's final expiry delta for a payment over a channel with fnn's default delay. */
const DEFAULT_HOLD_MS = 121_860_000;
/** 15,311 min: the same for a channel an opener may have given 84 epochs. */
const PEER_CHANNEL_HOLD_MS = 918_660_000;
/** The Lightning payout window both holds are built on: 124 blocks x 15 min. */
const PAYOUT_WINDOW_MS = hours(31);

/** 5 cWBTC: the least funding fnn-hub accepts on its own for a cWBTC channel a node opens. */
const MIN_PEER_CWBTC = 5n * ONE_WHOLE;
const CWBTC_WITH_PEERS = { ...CWBTC_ENTRY, peerChannels: { minAmount: MIN_PEER_CWBTC.toString() } };
/** RUSD as before, cWBTC taking peer channels. */
const PEER_CHANNELS_ON = { FIBER_ASSETS: JSON.stringify([RUSD_ENTRY, CWBTC_WITH_PEERS]) };

const PATH = { FIBER_NODE: "/v1/fiber/node", INBOUND: "/v1/fiber/inbound-channels" } as const;
const BROWSER_NODE = `02${"b1".repeat(32)}`;

/** A fiber_to_ln swap in `asset` with the demo wallet's payout invoice, not paid yet, and its hold invoice as fnn reads it. */
async function unpaidFiberToLn(hub: AssetsHub, asset: FiberAssetId = "CWBTC") {
  const quote = await postQuote(hub, lightningSideQuote("fiber_to_ln", asset, SATS));
  const payout = await postDemoInvoice(hub, quote);
  const swap = await createSwap(hub, quote.id, payout.invoice);
  return { quote, payout, swap, hold: await hub.hubFiber.parseInvoice(swap.pay.invoice) };
}

/** The same, paid by the demo wallet's Fiber node, then engine passes until the swap is done. */
async function paidFiberToLn(hub: AssetsHub, asset: FiberAssetId = "CWBTC") {
  const unpaid = await unpaidFiberToLn(hub, asset);
  await postDemoPayment(hub, unpaid.swap.id);
  return { ...unpaid, done: await processUntilFinished(hub, unpaid.swap.id) };
}

/** The cltv_limit the hub saved for the Lightning payout (not part of the API). */
const payoutLockLimitOf = (hub: AssetsHub, swap: SwapDto): number | null | undefined => hub.store.getSwap(swap.id)?.payoutLockLimit;

const hubPaidOnLightning = (hub: AssetsHub): boolean => hub.hubLn.calls.includes("payInvoice");

describe("peer channels over HTTP (FIBER_ASSETS peerChannels on cWBTC), with the fakes", () => {
  const hubs = useAssetsHubs();

  describe("GET /v1/fiber/node", () => {
    it("gives cWBTC's peer channel terms and null for the assets without them, the rest unchanged", async () => {
      const hub = await hubs.start(PEER_CHANNELS_ON);
      const body = (await hub.http().get(PATH.FIBER_NODE).expect(200)).body as FiberNodeDto;

      expect(body.assets).toEqual([
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
          peerChannels: { minAmount: "500000000", assumedCommitmentDelayEpochs: 84 },
        },
      ]);
    });

    it("writes a minAmount given as a JSON number as a decimal string, per asset", async () => {
      const hub = await hubs.start({
        FIBER_ASSETS: JSON.stringify([{ ...RUSD_ENTRY, peerChannels: { minAmount: 1 } }, { ...CWBTC_ENTRY, peerChannels: { minAmount: 250_000_000 } }]),
      });
      const body = (await hub.http().get(PATH.FIBER_NODE).expect(200)).body as FiberNodeDto;

      expect(body.assets.map(({ id, peerChannels }) => [id, peerChannels])).toEqual([
        ["CKB", null],
        ["RUSD", { minAmount: "1", assumedCommitmentDelayEpochs: 84 }],
        ["CWBTC", { minAmount: "250000000", assumedCommitmentDelayEpochs: 84 }],
      ]);
    });

    it("gives peerChannels null for every asset when FIBER_ASSETS sets none", async () => {
      const hub = await hubs.start();
      const body = (await hub.http().get(PATH.FIBER_NODE).expect(200)).body as FiberNodeDto;

      expect(body.assets.map(({ id, peerChannels }) => [id, peerChannels])).toEqual([
        ["CKB", null],
        ["RUSD", null],
        ["CWBTC", null],
      ]);
    });
  });

  describe("inbound channels do not count a private channel a node opened as payout liquidity", () => {
    // The hub's own public cWBTC channel holds 5 cWBTC, below the 10 cWBTC an inbound channel takes; a node's channel
    // holds 100 cWBTC on the hub's side (what it paid the hub).
    const PEER_CWBTC_CHANNEL: FakeChannel = {
      channelId: `0x${"a4".repeat(32)}`,
      peer: BROWSER_NODE,
      udtTypeScript: CWBTC_SCRIPT,
      ready: true,
      localBalance: 100n * ONE_WHOLE,
      remoteBalance: 0n,
      openedByPeer: true,
    };
    const channelsWith = (peerChannel: FakeChannel): FakeChannel[] => [
      ...HUB_CHANNELS.filter((channel) => channel.udtTypeScript !== CWBTC_SCRIPT),
      { channelId: `0x${"a3".repeat(32)}`, peer: "relay", udtTypeScript: CWBTC_SCRIPT, ready: true, localBalance: 5n * ONE_WHOLE, remoteBalance: 0n },
      peerChannel,
    ];

    it("private: cWBTC is not fundable, and a request is 422 insufficient_liquidity", async () => {
      const hub = await hubs.start(PEER_CHANNELS_ON, channelsWith({ ...PEER_CWBTC_CHANNEL, public: false }));
      hub.hubFiber.connectPeer(BROWSER_NODE);

      const body = (await hub.http().get(PATH.FIBER_NODE).expect(200)).body as FiberNodeDto;
      expect(body.inbound.fundable).toMatchObject({ CWBTC: false, RUSD: true });
      expectApiError(await hub.http().post(PATH.INBOUND).send({ nodeId: BROWSER_NODE, asset: "CWBTC" }), 422, "insufficient_liquidity");
    });

    it("public: the same channel routes, so cWBTC is fundable", async () => {
      const hub = await hubs.start(PEER_CHANNELS_ON, channelsWith({ ...PEER_CWBTC_CHANNEL, public: true }));

      const body = (await hub.http().get(PATH.FIBER_NODE).expect(200)).body as FiberNodeDto;
      expect(body.inbound.fundable).toMatchObject({ CWBTC: true });
    });
  });

  describe("fiber_to_ln in an asset that takes peer channels", () => {
    it("sizes the cWBTC hold invoice for an 84-epoch channel: 224 h + 11 min on top of the 31 h payout window", async () => {
      const hub = await hubs.start(PEER_CHANNELS_ON);
      const { hold } = await unpaidFiberToLn(hub);

      expect(hold.finalExpiryDeltaMs).toBe(PEER_CHANNEL_HOLD_MS);
      expect(hold.finalExpiryDeltaMs).toBeGreaterThanOrEqual(hours(224) + PAYOUT_WINDOW_MS);
    });

    it("keeps RUSD's hold as it was: only the asset that takes peer channels gets the long hold", async () => {
      const hub = await hubs.start(PEER_CHANNELS_ON);

      expect((await unpaidFiberToLn(hub, "RUSD")).hold.finalExpiryDeltaMs).toBe(DEFAULT_HOLD_MS);
    });

    it("succeeds when the payer pays over its own channel opened with 84 epochs", async () => {
      const hub = await hubs.start(PEER_CHANNELS_ON);
      hub.userFiber.opensPaymentChannel = { commitmentDelayEpochs: 84 };

      const { swap, done } = await paidFiberToLn(hub);

      expect(done).toMatchObject({ asset: "CWBTC", state: "succeeded", refunded: false, failureReason: null });
      expect(sha256(done.preimage ?? "")).toBe(done.paymentHash);
      expect(await hub.hubFiber.getInvoice(done.paymentHash)).toMatchObject({ state: "Paid" });
      expect(await hub.userFiber.getPayment(done.paymentHash)).toMatchObject({ state: "Success", preimage: done.preimage });
      // TLC expiry 15,551 min after payment; fnn fails it 224 h + 1 min earlier: 2,110 min. Less the 10 min margin:
      // 2,100 min / 15 min = 140 blocks.
      expect(payoutLockLimitOf(hub, swap)).toBe(140);
    });

    it("succeeds as well over a channel the payer opened with 1 epoch: the hub counts 84 whatever the opener chose", async () => {
      const hub = await hubs.start(PEER_CHANNELS_ON);
      hub.userFiber.opensPaymentChannel = { commitmentDelayEpochs: 1 };

      const { swap, done } = await paidFiberToLn(hub);

      expect(done).toMatchObject({ state: "succeeded", refunded: false });
      expect(sha256(done.preimage ?? "")).toBe(done.paymentHash);
      expect(payoutLockLimitOf(hub, swap)).toBe(140);
    });

    it("succeeds over a channel the hub opened, with the payout lock at the profile's 48 h cap", async () => {
      const hub = await hubs.start(PEER_CHANNELS_ON);
      hub.userFiber.opensPaymentChannel = null;

      const { swap, done } = await paidFiberToLn(hub);

      expect(done).toMatchObject({ state: "succeeded", refunded: false });
      // 15,551 - 161 - 10 = 15,380 min = 1,025 blocks, capped at 48 h / 15 min = 192.
      expect(payoutLockLimitOf(hub, swap)).toBe(192);
    });
  });

  describe("fiber_to_ln in an asset without peer channels (cWBTC as in the VPS example)", () => {
    it("keeps the hold for fnn's default delay", async () => {
      const hub = await hubs.start();

      expect((await unpaidFiberToLn(hub)).hold.finalExpiryDeltaMs).toBe(DEFAULT_HOLD_MS);
    });

    it("refunds a payment over the payer's own 2-epoch channel with peerChannelHoldTooShort(84), never paying out", async () => {
      const hub = await hubs.start();
      hub.userFiber.opensPaymentChannel = { commitmentDelayEpochs: 2 };

      const { done } = await paidFiberToLn(hub);

      // fnn adds the TLC (2,271 min >= 320 min), but the hub counts 84 epochs for a channel the payer opened: the hold
      // would fail 224 h + 1 min before its expiry, long before now, so no payout fits.
      expect(done).toMatchObject({ asset: "CWBTC", state: "failed", refunded: true, preimage: null });
      expect(done.failureReason).toBe(SWAP_REASON.peerChannelHoldTooShort(84));
      expect(done.failureReason).toMatch(/counts 84 epochs/);
      expect(done.failureReason).toMatch(/channel the hub opened/);
      expect(hubPaidOnLightning(hub)).toBe(false);
      expect(await hub.hubFiber.getInvoice(done.paymentHash)).toMatchObject({ state: "Cancelled" });
      expect(await hub.userFiber.getPayment(done.paymentHash)).toMatchObject({ state: "Failed" });
    });

    it("never gets paid over the payer's own 84-epoch channel: the payer's node refuses the TLC, the swap expires unpaid", async () => {
      const hub = await hubs.start();
      hub.userFiber.opensPaymentChannel = { commitmentDelayEpochs: 84 };
      const { swap } = await unpaidFiberToLn(hub);

      // 2,271 min of TLC is less than the 224 h fnn needs on such a channel: the demo payment fails at once.
      expectApiError(await hub.http().post(API_PATH.DEMO_PAYMENTS).send({ swapId: swap.id }), 503, "upstream_unavailable");
      expect(await hub.userFiber.getPayment(swap.paymentHash)).toMatchObject({ state: "Failed", failedError: "ExpiryTooSoon" });
      expect(await hub.hubFiber.getInvoice(swap.paymentHash)).toMatchObject({ state: "Open" });
      await hub.engine.processOpenSwaps();
      expect((await getSwap(hub, swap.id)).state).toBe("pending");

      hub.clock.advance(minutes(10)); // past the 180 s quote
      const done = await processUntilFinished(hub, swap.id);

      expect(done).toMatchObject({ state: "failed", refunded: true, failureReason: SWAP_REASON.quoteExpiredUnpaid });
      expect(hubPaidOnLightning(hub)).toBe(false);
    });

    it("succeeds over a channel the hub opened, as before", async () => {
      const hub = await hubs.start();
      hub.userFiber.opensPaymentChannel = null;

      const { swap, hold, done } = await paidFiberToLn(hub);

      expect(hold.finalExpiryDeltaMs).toBe(DEFAULT_HOLD_MS);
      expect(done).toMatchObject({ state: "succeeded", refunded: false, failureReason: null });
      expect(sha256(done.preimage ?? "")).toBe(done.paymentHash);
      // 2,271 - 161 - 10 = 2,100 min = 140 blocks.
      expect(payoutLockLimitOf(hub, swap)).toBe(140);
    });
  });

  describe("a payout window that closes between accepting the payment and paying out", () => {
    // Both payments are held until 2,110 min after they arrive (hub channel: 2,271 - 161; a payer's 84-epoch channel in
    // a peer-channel asset: 15,551 - 13,441). 25 h later: (2,110 - 1,500 - 10) / 15 = 40 blocks, below the 44 needed.
    async function acceptThenWait(hub: AssetsHub) {
      // Without the scheduler, node push hints no longer move the swap: only the engine passes below do, one step each.
      await hub.app.get(SwapSchedulerService).onModuleDestroy();
      const { swap } = await unpaidFiberToLn(hub);
      await postDemoPayment(hub, swap.id);
      await hub.engine.processOpenSwaps();
      expect((await getSwap(hub, swap.id)).state).toBe("incoming_accepted");
      hub.clock.advance(hours(25));
      return processUntilFinished(hub, swap.id);
    }

    it("over a channel the hub opened: refunded with the timing reason, as before", async () => {
      const hub = await hubs.start();

      const done = await acceptThenWait(hub);

      expect(done).toMatchObject({ state: "failed", refunded: true });
      expect(done.failureReason).toBe("The held Fiber payment leaves room for a Lightning payout of 40 blocks, and this Lightning invoice needs 44.");
      expect(hubPaidOnLightning(hub)).toBe(false);
    });

    it("over the payer's own channel: refunded with peerChannelHoldTooShort(84)", async () => {
      const hub = await hubs.start(PEER_CHANNELS_ON);
      hub.userFiber.opensPaymentChannel = { commitmentDelayEpochs: 84 };

      const done = await acceptThenWait(hub);

      expect(done).toMatchObject({ state: "failed", refunded: true, failureReason: SWAP_REASON.peerChannelHoldTooShort(84) });
      expect(hubPaidOnLightning(hub)).toBe(false);
    });
  });

  describe("ln_to_fiber is unaffected", () => {
    it("pays 9,950 cWBTC base units with the same Lightning hold as without peer channels (CLTV 847)", async () => {
      const lnToFiber = async (env: Record<string, string>) => {
        const hub = await hubs.start(env);
        const quote = await postQuote(hub, lightningSideQuote("ln_to_fiber", "CWBTC", SATS));
        const payout = await postDemoInvoice(hub, quote);
        const swap = await createSwap(hub, quote.id, payout.invoice);
        await postDemoPayment(hub, swap.id);
        const done = await processUntilFinished(hub, swap.id);
        return { quote, done, holdCltv: (await hub.hubLn.decodeInvoice(swap.pay.invoice)).cltvExpiry };
      };

      const withPeers = await lnToFiber(PEER_CHANNELS_ON);
      const without = await lnToFiber({});

      expect(withPeers.quote.receive).toEqual({ network: "fiber", asset: "CWBTC", amount: "9950", decimals: 8 });
      expect(withPeers.done).toMatchObject({ state: "succeeded", refunded: false });
      expect(sha256(withPeers.done.preimage ?? "")).toBe(withPeers.done.paymentHash);
      // The demo Fiber invoice's 160 min + one 4 h hop + 10 min = 410 min of payout lock = 820 fast blocks (30 s),
      // + 18 (LND hold expiry delta) + 6 (margin) + 3 (padding) = 847.
      expect(withPeers.holdCltv).toBe(847);
      expect(without.holdCltv).toBe(847);
    });
  });
});
