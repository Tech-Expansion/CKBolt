import type { FiberOfferedTlc } from "../../../src/application/ports/fiber.port";
import type { LightningPort } from "../../../src/application/ports/lightning.port";
import { LnToFiberFlow } from "../../../src/application/swaps/ln-to-fiber.flow";
import { FIBER_RPC_METHOD } from "../../../src/common/constants/fiber-rpc.constants";
import { FIBER_PAYOUT_GUARD } from "../../../src/common/constants/timing.constants";
import { describeError } from "../../../src/common/utils/error.util";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import { assetRegistryOf } from "../../../src/config/hub.config";
import type { Swap } from "../../../src/domain/types";
import { FiberRpcAdapter } from "../../../src/infrastructure/fiber/fiber-rpc.adapter";
import { toOfferedTlcs, toParsedInvoice } from "../../../src/infrastructure/fiber/fiber-rpc.mappers";
import { FIBER_RPC_RESULT_SCHEMAS, type RpcChannel, type RpcCkbInvoice } from "../../../src/infrastructure/fiber/fiber-rpc.schemas";
import { FakeClock } from "../../fakes";
import {
  failWith,
  holdInvoiceAttrs,
  INVOICE_ADDRESS,
  PAYMENT_HASH,
  ScriptedFiberRpc,
  T0,
  wireChannel,
  wireInvoice,
  wireInvoiceResult,
  wireTlc,
  type WireAttr,
} from "../fiber/fiber.fixtures";
import {
  callCount,
  hours,
  makeSwapHarness,
  minutes,
  payHoldInvoice,
  processPasses,
  processToRest,
  silenceLogs,
  startSwap,
  swapConfig,
  type LogSpies,
  type SwapHarness,
} from "./swaps.fixtures";

/**
 * Review of the ln_to_fiber payout guard (LnToFiberFlow.guardPayout: commit 30725ea, and the pass reworked on
 * 2026-11-13), written by a second agent: what swap-engine.payout-guard.spec.ts and the e2e spec leave out. Groups:
 * - the payee and the TLC's peer reach the flow's `===` in one spelling, whatever spelling fnn uses (the flow does not
 *   normalise them itself, so this rests on the Fiber adapter);
 * - one pass with several channels: channels that need no payee close before the payee is read, every close is tried
 *   even when another fails, a payee the invoice does not name counts as every routing channel's peer, a payee that
 *   cannot be read closes no routing channel until a later pass reads it, and any failure is thrown after the pass,
 *   naming what was closed and (through describeError) why the rest failed;
 * - what happens after the close: the payout then fails (on-chain timeout) and the hub refunds, with no second close.
 */

const PRIVATE_CHANNEL = `0x${"a1".repeat(32)}`;
const ROUTER_CHANNEL = `0x${"b2".repeat(32)}`;
const PEER_OPENED_CHANNEL = `0x${"d4".repeat(32)}`;
/** A public channel the hub opened to the payout invoice's payee. */
const PAYEE_CHANNEL = `0x${"c3".repeat(32)}`;
/** A router's node id: a node the hub opened a public channel to, never the payout invoice's payee here. */
const ROUTER = `02${"ee".repeat(32)}`;
/** The peer of the private channel: not the payout invoice's payee (h.userFiber), as in a private channel to a router. */
const PRIVATE_PEER = `03${"cd".repeat(32)}`;
/** fnn's default commitment delay (1 epoch of 4 h) counted 25 % longer, plus the 30-minute margin. */
const DEFAULT_LEAD_MS = hours(5) + minutes(30);

describe("payout guard review: the payee and the TLC's peer compare in one spelling", () => {
  /** The payee's node id as fnn could write it in either place. fnn v0.9.1 writes 33-byte compressed lower-case hex. */
  const PAYEE_KEY = `03${"ab".repeat(32)}`;
  const invoiceWithPayee = (payee: string): RpcCkbInvoice =>
    FIBER_RPC_RESULT_SCHEMAS[FIBER_RPC_METHOD.PARSE_INVOICE].parse({ invoice: wireInvoice({ attrs: withPayee(payee) }) }).invoice;
  const withPayee = (payee: string): WireAttr[] => [...holdInvoiceAttrs().filter((attr) => !("payee_public_key" in attr)), { payee_public_key: payee }];
  const channelsWith = (pubkey: string): RpcChannel[] =>
    FIBER_RPC_RESULT_SCHEMAS[FIBER_RPC_METHOD.LIST_CHANNELS].parse({
      channels: [wireChannel({ pubkey, pendingTlcs: [wireTlc({ status: { Outbound: "Committed" } })] })],
    }).channels;

  it.each([
    ["the same spelling", PAYEE_KEY, PAYEE_KEY],
    ["0x and upper case in the invoice", `0x${PAYEE_KEY.toUpperCase()}`, PAYEE_KEY],
    ["0x and upper case on the channel", PAYEE_KEY, `0x${PAYEE_KEY.toUpperCase()}`],
    ["upper case on both sides, 0x on one", PAYEE_KEY.toUpperCase(), `0x${PAYEE_KEY.toUpperCase()}`],
  ])("toParsedInvoice's payee equals toOfferedTlcs' peer with %s", (_label, invoicePayee, channelPubkey) => {
    const { payee } = toParsedInvoice(invoiceWithPayee(invoicePayee));
    const [tlc] = toOfferedTlcs(channelsWith(channelPubkey), PAYMENT_HASH);
    expect(payee).toBe(PAYEE_KEY);
    expect(tlc?.peer).toBe(payee);
  });

  describe("LnToFiberFlow.guardPayout over the real Fiber adapter (wire-level fnn answers)", () => {
    const EXPIRES_AT = T0 + hours(7);
    const SENT_AT = T0;
    /** Past both the 10-minute grace and expiry less 5.5 h (fnn's default delay): every TLC below is due. */
    const DUE_AT = EXPIRES_AT - DEFAULT_LEAD_MS;
    const swap = { paymentHash: PAYMENT_HASH, payoutInvoice: INVOICE_ADDRESS } as Swap;
    const outbound = () => [wireTlc({ status: { Outbound: "Committed" }, expiry: EXPIRES_AT })];

    let rpc: ScriptedFiberRpc;
    let flow: LnToFiberFlow;

    beforeEach(() => {
      rpc = new ScriptedFiberRpc();
      const config = swapConfig();
      flow = new LnToFiberFlow({
        lightning: {} as LightningPort,
        fiber: new FiberRpcAdapter(rpc, "testnet"),
        assets: assetRegistryOf(config),
        profile: config.timing,
        clock: new FakeClock(DUE_AT),
        config,
      });
      rpc.on(FIBER_RPC_METHOD.SHUTDOWN_CHANNEL, () => null);
    });

    const closedChannels = (): unknown[] =>
      rpc.calls.filter((call) => call.method === FIBER_RPC_METHOD.SHUTDOWN_CHANNEL).map((call) => (call.params[0] as { channel_id: string }).channel_id);

    it("closes the hub's public channel to the payee and leaves the router's open, though fnn spells the payee another way", async () => {
      rpc.on(FIBER_RPC_METHOD.LIST_CHANNELS, () => ({
        channels: [
          wireChannel({ channelId: ROUTER_CHANNEL, pubkey: ROUTER, isPublic: true, isAcceptor: false, pendingTlcs: outbound() }),
          wireChannel({ channelId: PAYEE_CHANNEL, pubkey: PAYEE_KEY, isPublic: true, isAcceptor: false, pendingTlcs: outbound() }),
        ],
      }));
      rpc.on(FIBER_RPC_METHOD.PARSE_INVOICE, () => wireInvoiceResult({ attrs: withPayee(`0x${PAYEE_KEY.toUpperCase()}`) }));

      await expect(flow.guardPayout(swap, SENT_AT)).resolves.toEqual([PAYEE_CHANNEL]);
      expect(closedChannels()).toEqual([PAYEE_CHANNEL]);
      expect(rpc.paramsOf(FIBER_RPC_METHOD.SHUTDOWN_CHANNEL)).toEqual({ channel_id: PAYEE_CHANNEL, force: true });
    });

    it("counts a public channel whose opener fnn does not report as opened by the peer: closed, without reading the payee", async () => {
      rpc.on(FIBER_RPC_METHOD.LIST_CHANNELS, () => ({
        channels: [wireChannel({ channelId: PEER_OPENED_CHANNEL, pubkey: ROUTER, isPublic: true, isAcceptor: null, pendingTlcs: outbound() })],
      }));

      await expect(flow.guardPayout(swap, SENT_AT)).resolves.toEqual([PEER_OPENED_CHANNEL]);
      expect(rpc.methods()).not.toContain(FIBER_RPC_METHOD.PARSE_INVOICE);
    });

    it("closes nothing on a channel that is already shutting down: fnn settles it on chain, and the payee is not read", async () => {
      rpc.on(FIBER_RPC_METHOD.LIST_CHANNELS, () => ({
        channels: [wireChannel({ channelId: PRIVATE_CHANNEL, pubkey: PAYEE_KEY, isPublic: false, stateName: "ShuttingDown", pendingTlcs: outbound() })],
      }));

      await expect(flow.guardPayout(swap, SENT_AT)).resolves.toEqual([]);
      expect(rpc.methods()).toEqual([FIBER_RPC_METHOD.LIST_CHANNELS]);
    });

    /** A private channel (needs no payee), a routing channel to a router and one to the payee, all due. */
    const threeDueChannels = () => ({
      channels: [
        wireChannel({ channelId: PRIVATE_CHANNEL, pubkey: PRIVATE_PEER, isPublic: false, isAcceptor: false, pendingTlcs: outbound() }),
        wireChannel({ channelId: ROUTER_CHANNEL, pubkey: ROUTER, isPublic: true, isAcceptor: false, pendingTlcs: outbound() }),
        wireChannel({ channelId: PAYEE_CHANNEL, pubkey: PAYEE_KEY, isPublic: true, isAcceptor: false, pendingTlcs: outbound() }),
      ],
    });
    const guardFailure = async (): Promise<AggregateError> => {
      const error: unknown = await flow.guardPayout(swap, SENT_AT).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(AggregateError);
      return error as AggregateError;
    };

    it("closes the channels that need no payee before it reads the payee, then the payee's routing channel", async () => {
      rpc.on(FIBER_RPC_METHOD.LIST_CHANNELS, threeDueChannels);
      rpc.on(FIBER_RPC_METHOD.PARSE_INVOICE, () => wireInvoiceResult({ attrs: withPayee(PAYEE_KEY) }));

      await expect(flow.guardPayout(swap, SENT_AT)).resolves.toEqual([PRIVATE_CHANNEL, PAYEE_CHANNEL]);
      expect(rpc.methods()).toEqual([
        FIBER_RPC_METHOD.LIST_CHANNELS,
        FIBER_RPC_METHOD.SHUTDOWN_CHANNEL,
        FIBER_RPC_METHOD.PARSE_INVOICE,
        FIBER_RPC_METHOD.SHUTDOWN_CHANNEL,
      ]);
      expect(closedChannels()).toEqual([PRIVATE_CHANNEL, PAYEE_CHANNEL]);
    });

    it("an unreadable payee: closes the private channel, no routing channel, throws; the next pass closes only the payee's", async () => {
      // Changed on 2026-11-13: a failed read used to close every due routing channel (fail-safe). Now it waits for a pass
      // that reads the payee, so an operator-chosen router's channel is not taken on chain over a passing RPC failure.
      rpc.once(FIBER_RPC_METHOD.LIST_CHANNELS, threeDueChannels);
      rpc.once(FIBER_RPC_METHOD.PARSE_INVOICE, failWith(FIBER_RPC_METHOD.PARSE_INVOICE, "simulated parse failure"));

      const error = await guardFailure();
      expect(closedChannels()).toEqual([PRIVATE_CHANNEL]);
      expect(error.message).toBe(`payout guard closed [${PRIVATE_CHANNEL}]; 1 step(s) failed`);
      expect(error.errors).toHaveLength(1);
      expect(describeError(error)).toContain("simulated parse failure");

      // Next pass: the private channel is closing (no longer listed), the payee reads fine.
      rpc.once(FIBER_RPC_METHOD.LIST_CHANNELS, () => ({ channels: threeDueChannels().channels.slice(1) }));
      rpc.once(FIBER_RPC_METHOD.PARSE_INVOICE, () => wireInvoiceResult({ attrs: withPayee(PAYEE_KEY) }));
      await expect(flow.guardPayout(swap, SENT_AT)).resolves.toEqual([PAYEE_CHANNEL]);
      expect(closedChannels()).toEqual([PRIVATE_CHANNEL, PAYEE_CHANNEL]);
    });

    it("a payout invoice that names no payee: every due routing channel is closed, and the pass succeeds", async () => {
      rpc.on(FIBER_RPC_METHOD.LIST_CHANNELS, threeDueChannels);
      rpc.on(FIBER_RPC_METHOD.PARSE_INVOICE, () => wireInvoiceResult({ attrs: holdInvoiceAttrs().filter((attr) => !("payee_public_key" in attr)) }));

      await expect(flow.guardPayout(swap, SENT_AT)).resolves.toEqual([PRIVATE_CHANNEL, ROUTER_CHANNEL, PAYEE_CHANNEL]);
    });

    it("a refused close does not hold back the others: each is tried, and the error names the channels that did close", async () => {
      rpc.on(FIBER_RPC_METHOD.LIST_CHANNELS, threeDueChannels);
      rpc.on(FIBER_RPC_METHOD.PARSE_INVOICE, () => wireInvoiceResult({ attrs: withPayee(PAYEE_KEY) }));
      rpc.once(FIBER_RPC_METHOD.SHUTDOWN_CHANNEL, failWith(FIBER_RPC_METHOD.SHUTDOWN_CHANNEL, "simulated refusal"));

      const error = await guardFailure();
      expect(closedChannels()).toEqual([PRIVATE_CHANNEL, PAYEE_CHANNEL]);
      expect(error.message).toBe(`payout guard closed [${PAYEE_CHANNEL}]; 1 step(s) failed`);
      expect(String((error.errors[0] as Error).message)).toContain("simulated refusal");
    });

    it("counts every failed step: a refused close and an unreadable payee make two, each reason in describeError", async () => {
      rpc.on(FIBER_RPC_METHOD.LIST_CHANNELS, threeDueChannels);
      rpc.on(FIBER_RPC_METHOD.PARSE_INVOICE, failWith(FIBER_RPC_METHOD.PARSE_INVOICE, "simulated parse failure"));
      rpc.once(FIBER_RPC_METHOD.SHUTDOWN_CHANNEL, failWith(FIBER_RPC_METHOD.SHUTDOWN_CHANNEL, "simulated refusal"));

      const error = await guardFailure();
      // The private channel's close is refused; the unreadable payee closes no routing channel.
      expect(closedChannels()).toEqual([PRIVATE_CHANNEL]);
      expect(error.message).toBe("payout guard closed []; 2 step(s) failed");
      expect(error.errors).toHaveLength(2);
      expect(describeError(error)).toMatch(/^payout guard closed \[\]; 2 step\(s\) failed \(.*simulated refusal.*; .*simulated parse failure.*\)$/);
    });

    it("reads no payee while no routing TLC is due, even with routing TLCs listed", async () => {
      const notDue = [wireTlc({ status: { Outbound: "Committed" }, expiry: DUE_AT + DEFAULT_LEAD_MS + minutes(1) })];
      rpc.on(FIBER_RPC_METHOD.LIST_CHANNELS, () => ({
        channels: [
          wireChannel({ channelId: PRIVATE_CHANNEL, pubkey: PRIVATE_PEER, isPublic: false, isAcceptor: false, pendingTlcs: outbound() }),
          wireChannel({ channelId: PAYEE_CHANNEL, pubkey: PAYEE_KEY, isPublic: true, isAcceptor: false, pendingTlcs: notDue }),
        ],
      }));

      await expect(flow.guardPayout(swap, SENT_AT)).resolves.toEqual([PRIVATE_CHANNEL]);
      expect(rpc.methods()).not.toContain(FIBER_RPC_METHOD.PARSE_INVOICE);
    });

    it("a failure to list the channels is thrown as it is, with nothing closed or read", async () => {
      rpc.on(FIBER_RPC_METHOD.LIST_CHANNELS, failWith(FIBER_RPC_METHOD.LIST_CHANNELS, "simulated list failure"));

      await expect(flow.guardPayout(swap, SENT_AT)).rejects.toThrow("simulated list failure");
      expect(rpc.methods()).toEqual([FIBER_RPC_METHOD.LIST_CHANNELS]);
    });
  });
});

describe("swap engine: payout guard review (one pass, several channels)", () => {
  let h: SwapHarness;
  let logs: LogSpies;

  beforeEach(() => {
    logs = silenceLogs();
    h = makeSwapHarness();
  });
  afterEach(() => jest.restoreAllMocks());

  const holdState = async (hash: string) => (await h.hubLn.lookupInvoice(hash))?.state;
  const offered = (patch: Partial<Omit<FiberOfferedTlc, "paymentHash">> = {}): Omit<FiberOfferedTlc, "paymentHash"> => ({
    expiresAt: h.clock.now() + hours(7),
    channelId: PRIVATE_CHANNEL,
    peer: PRIVATE_PEER,
    channelPublic: false,
    channelOpenedByPeer: false,
    ...patch,
  });
  const routerTlc = (expiresAt: number) => offered({ channelId: ROUTER_CHANNEL, peer: ROUTER, channelPublic: true, expiresAt });

  /** An ln_to_fiber swap whose payout hangs: sent, in flight, the payee holding the TLC. Returns it and when it was sent. */
  async function holdingPayee() {
    const started = await startSwap(h, "ln_to_fiber");
    const hash = sha256Hex(started.preimage);
    h.fiberNet.setPayoutBehavior(hash, "hang");
    await payHoldInvoice(h, started.swap);
    const sentAt = h.clock.now();
    expect((await processPasses(h, started.swap.id, 2)).state).toBe("outgoing_in_flight");
    return { ...started, hash, sentAt };
  }

  it("a failure to read the payee: the private channel still closes, no routing channel does, the log says why; next pass closes the payee's", async () => {
    // Flipped on 2026-11-13 (it pinned the review's finding 2, when the read came first and its failure closed nothing),
    // then changed the same day: a failed read no longer closes every routing channel, it waits for a pass that reads it.
    const { swap, hash, sentAt } = await holdingPayee();
    const expiresAt = sentAt + hours(7);
    h.hubFiber.setOfferedTlcs(hash, [
      offered({ expiresAt }),
      routerTlc(expiresAt),
      offered({ channelId: PAYEE_CHANNEL, peer: h.userFiber.nodeId, channelPublic: true, expiresAt }),
    ]);
    h.clock.set(expiresAt - DEFAULT_LEAD_MS);
    h.hubFiber.failNext = "parseInvoice";

    const after = await processPasses(h, swap.id, 1);
    expect(h.hubFiber.forceClosedChannels).toEqual([PRIVATE_CHANNEL]);
    expect(after).toMatchObject({ state: "outgoing_in_flight", refunded: false });
    expect(logs.warn).toHaveBeenCalledWith(
      `Swap ${swap.id}: could not check the payout's channels: payout guard closed [${PRIVATE_CHANNEL}]; 1 step(s) failed (parseInvoice: simulated transport error)`,
    );
    expect(await holdState(hash)).toBe("ACCEPTED");

    await processPasses(h, swap.id, 1);
    expect(h.hubFiber.forceClosedChannels).toEqual([PRIVATE_CHANNEL, PAYEE_CHANNEL]);
    await processPasses(h, swap.id, 2);
    expect(h.hubFiber.forceClosedChannels).toEqual([PRIVATE_CHANNEL, PAYEE_CHANNEL]);
    expect(callCount(h.hubLn, "cancelInvoice")).toBe(0);
  });

  it("a failed close does not hold back the others: they close in the same pass, the log names them, the next pass retries", async () => {
    // Flipped on 2026-11-13 (it pinned the review's finding 3): closes used to run one after another and the first error
    // ended the pass. The fake refuses the first close it is asked for: the private channel's.
    const { swap, hash, sentAt } = await holdingPayee();
    const expiresAt = sentAt + hours(7);
    h.hubFiber.setOfferedTlcs(hash, [
      offered({ expiresAt }),
      offered({ channelId: PEER_OPENED_CHANNEL, peer: ROUTER, channelPublic: true, channelOpenedByPeer: true, expiresAt }),
    ]);
    h.clock.set(expiresAt - DEFAULT_LEAD_MS);
    h.hubFiber.failNext = "forceCloseChannel";

    await processPasses(h, swap.id, 1);
    expect(callCount(h.hubFiber, "forceCloseChannel")).toBe(2);
    expect(h.hubFiber.forceClosedChannels).toEqual([PEER_OPENED_CHANNEL]);
    expect(logs.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `could not check the payout's channels: payout guard closed [${PEER_OPENED_CHANNEL}]; 1 step(s) failed (forceCloseChannel: simulated transport error)`,
      ),
    );

    await processPasses(h, swap.id, 2);
    expect(h.hubFiber.forceClosedChannels).toEqual([PEER_OPENED_CHANNEL, PRIVATE_CHANNEL]);
    expect(callCount(h.hubFiber, "forceCloseChannel")).toBe(3);
  });

  it("a payee the node reports as missing (null): every due routing channel is closed, and the pass is not a failure", async () => {
    const { swap, hash, sentAt } = await holdingPayee();
    const expiresAt = sentAt + hours(7);
    const otherRouterChannel = `0x${"e5".repeat(32)}`;
    h.hubFiber.setOfferedTlcs(hash, [routerTlc(expiresAt), offered({ channelId: otherRouterChannel, peer: `02${"f6".repeat(32)}`, channelPublic: true, expiresAt })]);
    h.clock.set(expiresAt - DEFAULT_LEAD_MS);
    const parse = h.hubFiber.parseInvoice.bind(h.hubFiber);
    jest.spyOn(h.hubFiber, "parseInvoice").mockImplementation(async (invoice) => ({ ...(await parse(invoice)), payee: null }));

    await processPasses(h, swap.id, 1);
    expect(h.hubFiber.forceClosedChannels).toEqual([ROUTER_CHANNEL, otherRouterChannel]);
    expect(logs.warn).not.toHaveBeenCalledWith(expect.stringContaining("could not check the payout's channels"));
    expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining(`force-closed channel ${otherRouterChannel}`));
  });

  it("a payee read failure and a refused close in one pass: nothing closes, the log counts both with their reasons; next pass recovers", async () => {
    const { swap, hash, sentAt } = await holdingPayee();
    const expiresAt = sentAt + hours(7);
    h.hubFiber.setOfferedTlcs(hash, [
      offered({ expiresAt }),
      routerTlc(expiresAt),
      offered({ channelId: PAYEE_CHANNEL, peer: h.userFiber.nodeId, channelPublic: true, expiresAt }),
    ]);
    h.clock.set(expiresAt - DEFAULT_LEAD_MS);
    jest.spyOn(h.hubFiber, "parseInvoice").mockRejectedValueOnce(new Error("simulated parse failure"));
    h.hubFiber.failNext = "forceCloseChannel";

    await processPasses(h, swap.id, 1);
    expect(h.hubFiber.forceClosedChannels).toEqual([]);
    expect(logs.warn).toHaveBeenCalledWith(
      expect.stringContaining("payout guard closed []; 2 step(s) failed (forceCloseChannel: simulated transport error; simulated parse failure)"),
    );

    await processPasses(h, swap.id, 1);
    expect(h.hubFiber.forceClosedChannels).toEqual([PRIVATE_CHANNEL, PAYEE_CHANNEL]);
  });

  it("reads the payee once per pass however many routing TLCs are due, and closes only the payee's channel", async () => {
    const { swap, hash, sentAt } = await holdingPayee();
    const expiresAt = sentAt + hours(7);
    h.hubFiber.setOfferedTlcs(hash, [
      routerTlc(expiresAt),
      offered({ channelId: PAYEE_CHANNEL, peer: h.userFiber.nodeId, channelPublic: true, expiresAt }),
      offered({ channelId: `0x${"e5".repeat(32)}`, peer: `02${"f6".repeat(32)}`, channelPublic: true, expiresAt }),
    ]);
    h.clock.set(expiresAt - DEFAULT_LEAD_MS);
    const parsedBefore = callCount(h.hubFiber, "parseInvoice");

    await processPasses(h, swap.id, 1);
    expect(callCount(h.hubFiber, "parseInvoice")).toBe(parsedBefore + 1);
    expect(h.hubFiber.forceClosedChannels).toEqual([PAYEE_CHANNEL]);
  });

  it("does not read the payee for a routing TLC that is not due yet, while it closes a private channel that is", async () => {
    const { swap, hash, sentAt } = await holdingPayee();
    h.hubFiber.setOfferedTlcs(hash, [offered({ expiresAt: sentAt + hours(5) }), routerTlc(sentAt + hours(9))]);
    h.clock.set(sentAt + FIBER_PAYOUT_GUARD.settleGraceMs);
    const parsedBefore = callCount(h.hubFiber, "parseInvoice");

    await processPasses(h, swap.id, 1);
    expect(h.hubFiber.forceClosedChannels).toEqual([PRIVATE_CHANNEL]);
    expect(callCount(h.hubFiber, "parseInvoice")).toBe(parsedBefore);
  });

  it("after the close, an on-chain timeout fails the payout: the hub refunds the hold once and closes nothing more", async () => {
    const { swap, hash, sentAt } = await holdingPayee();
    h.hubFiber.setOfferedTlcs(hash, [offered({ expiresAt: sentAt + hours(7) })]);
    h.clock.set(sentAt + hours(2));
    await processPasses(h, swap.id, 1);
    expect(h.hubFiber.forceClosedChannels).toEqual([PRIVATE_CHANNEL]);

    h.fiberNet.resolveHanging(hash, "fail");
    const done = await processToRest(h, swap.id);
    expect(done).toMatchObject({ state: "failed", refunded: true });
    expect(await holdState(hash)).toBe("CANCELED");
    expect(callCount(h.hubLn, "cancelInvoice")).toBe(1);
    expect(callCount(h.hubLn, "settleInvoice")).toBe(0);
    expect(h.hubFiber.forceClosedChannels).toEqual([PRIVATE_CHANNEL]);
  });

  it("never closes for another payment's TLCs", async () => {
    const { swap, hash, sentAt } = await holdingPayee();
    h.hubFiber.setOfferedTlcs(sha256Hex("ff".repeat(32)), [offered({ expiresAt: sentAt + hours(7) })]);
    h.clock.set(sentAt + hours(3));
    await processPasses(h, swap.id, 2);
    expect(h.hubFiber.forceClosedChannels).toEqual([]);
    expect(await holdState(hash)).toBe("ACCEPTED");
  });
});
