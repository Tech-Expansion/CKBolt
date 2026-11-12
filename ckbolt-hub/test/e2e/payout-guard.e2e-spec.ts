import { createHash, randomBytes } from "node:crypto";
import { CLOCK } from "../../src/application/ports/tokens";
import type { Clock } from "../../src/application/ports/clock.port";
import { FIBER_CHANNEL_READY_STATE } from "../../src/common/constants/fiber-rpc.constants";
import { MS_PER_HOUR, MS_PER_MINUTE } from "../../src/common/constants/protocol.constants";
import { SWAP_DIRECTION, SWAP_STATE } from "../../src/common/constants/swap.constants";
import { canonicalHex } from "../../src/common/utils/hex.util";
import { createSwap, getSwap, lightningSideQuote, postQuote, waitForSwap } from "../support/hub-http";
import { swapSides } from "./support/devnet-nodes";
import { useE2eContext } from "./support/e2e-flow";
import type { FnnChannel } from "../../devnet/scripts/lib/fiber";

/**
 * The ln_to_fiber payout guard (FIBER_PAYOUT_GUARD, docs/phase-3-plan.md section 3) on the devnet's real nodes. The
 * payee (fnn-user) holds the hub's TLC with a hold invoice instead of settling it, as a payee that withholds the
 * preimage would. Once the hub's clock passes fiberPayoutForceCloseAt, the hub force-closes the channel the TLC is on,
 * whether private or public (a public node can be the payee); the payee then claims the TLC on chain with the preimage,
 * fnn-hub reports it as the payout's preimage, and the hub collects the Lightning hold invoice it still holds.
 *
 * The hub runs with a clock a test can move forward, so it acts as if 2 hours had passed without waiting for them;
 * the CKB devnet's epochs last about ten blocks, so the channel's commitment delay passes in seconds of real time.
 */

const SATS = BigInt(3_101);
/** Funding of the channel the hub opens to fnn-user for each case: enough for the payout and its reserve. */
const PAYOUT_CHANNEL_CKB = BigInt(5_000) * BigInt(100_000_000);
/** How long the hub's clock jumps: past the force-close point of a payout (expiry less 5.5 h, about 1.2 h after sending). */
const CLOCK_JUMP_MS = 2 * MS_PER_HOUR;
/** On-chain steps (open, force close, the delay, the claim) on a devnet mining a block a second. */
const ON_CHAIN_TIMEOUT_MS = 10 * MS_PER_MINUTE;
const POLL_MS = 1_000;

/** A clock that reads the system's, moved forward by `offsetMs`. */
class MovableClock implements Clock {
  offsetMs = 0;
  now(): number {
    return Date.now() + this.offsetMs;
  }
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = ON_CHAIN_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const sameId = (a: string, b: string): boolean => canonicalHex(a) === canonicalHex(b);
const holdsTlcFor = (channel: FnnChannel, hash: string): boolean => channel.pending_tlcs.some((tlc) => sameId(tlc.payment_hash, hash));

const CASES = [
  { channel: "a private channel", isPublic: false },
  { channel: "a public channel whose peer is the payee", isPublic: true },
] as const;

describe.each(CASES)("payout guard on the devnet: a payee that holds the payout over $channel", ({ isPublic }) => {
  const e2e = useE2eContext();
  let disabled: string[] = [];

  afterAll(async () => {
    // Give the devnet back as it was: the other CKB channels on again (the test's own channel is closed by the test).
    for (const id of disabled) await e2e.nodes.fiber.hub.setChannelEnabled(id, true).catch(() => undefined);
  });

  it(
    "force-closes the channel; the payee claims on chain with the preimage; the hub collects the Lightning hold",
    async () => {
      const { fiber, lnd, pubkeys } = e2e.nodes;

      // A fresh CKB channel fnn-hub -> fnn-user; every other CKB channel with fnn-user off for now, so the payout takes it.
      const ckbChannels = async () => (await fiber.hub.channelsWith(pubkeys.fnnUser)).filter((c) => c.funding_udt_type_script === null);
      const before = new Set((await ckbChannels()).map((c) => c.channel_id));
      await fiber.hub.openChannel(pubkeys.fnnUser, PAYOUT_CHANNEL_CKB, null, isPublic);
      const payoutChannel = await until(
        async () => (await ckbChannels()).find((c) => !before.has(c.channel_id)),
        (c) => c?.state.state_name === FIBER_CHANNEL_READY_STATE,
        "the payout channel to be ready",
      );
      expect(payoutChannel?.is_public === true).toBe(isPublic);
      const others = (await ckbChannels()).filter((c) => !sameId(c.channel_id, payoutChannel!.channel_id));
      for (const channel of others) await fiber.hub.setChannelEnabled(channel.channel_id, false);
      disabled = others.map((c) => c.channel_id);

      const clock = new MovableClock();
      const hub = await e2e.startHub({ providers: [[CLOCK, clock]] });

      // The payee's invoice is a hold invoice: fnn-user keeps the TLC and never settles it by itself.
      const preimage = randomBytes(32).toString("hex");
      const paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
      const quote = await postQuote(hub, lightningSideQuote(SWAP_DIRECTION.LN_TO_FIBER, "CKB", SATS));
      const payoutInvoice = await fiber.user.newInvoice({
        amount: BigInt(quote.receive.amount),
        udtTypeScript: null,
        hashLock: { paymentHash },
        expirySeconds: 3_600,
        description: "payout guard e2e",
      });
      const swap = await createSwap(hub, quote.id, payoutInvoice);

      // lnd-user pays the hub's hold invoice; lncli returns only once it is settled or cancelled.
      const paying = lnd.user.payInvoice(swap.pay.invoice, { feeLimitSats: BigInt(1_000), timeoutSeconds: 900 }).catch((e: unknown) => e);
      await waitForSwap(hub, swap.id, (s) => s.state === SWAP_STATE.OUTGOING_IN_FLIGHT, ON_CHAIN_TIMEOUT_MS, POLL_MS);
      await until(() => fiber.user.getInvoice(paymentHash), (i) => i.status === "Received", "the payee to hold the payout");
      const carrying = (await fiber.hub.channelsWith(pubkeys.fnnUser)).find((c) => holdsTlcFor(c, paymentHash));
      expect(carrying?.channel_id).toBe(payoutChannel?.channel_id);

      // Before the force-close point nothing happens; past it the hub closes that channel and only that one.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      expect((await fiber.hub.channelsWith(pubkeys.fnnUser)).find((c) => sameId(c.channel_id, payoutChannel!.channel_id))?.state.state_name).toBe(
        FIBER_CHANNEL_READY_STATE,
      );
      clock.offsetMs = CLOCK_JUMP_MS;
      await until(
        async () => (await fiber.hub.channelsWith(pubkeys.fnnUser, true)).find((c) => sameId(c.channel_id, payoutChannel!.channel_id)),
        (c) => c !== undefined && c.state.state_name !== FIBER_CHANNEL_READY_STATE,
        "the hub to force-close the payout channel",
      );
      for (const id of disabled) {
        const other = (await fiber.hub.channelsWith(pubkeys.fnnUser)).find((c) => sameId(c.channel_id, id));
        expect(other?.state.state_name).toBe(FIBER_CHANNEL_READY_STATE);
      }
      expect((await getSwap(hub, swap.id)).state).toBe(SWAP_STATE.OUTGOING_IN_FLIGHT);
      expect(await swapSides(e2e.nodes, SWAP_DIRECTION.LN_TO_FIBER).holdInvoiceStatus(paymentHash)).toBe("ACCEPTED");

      // The payee reveals the preimage: its watchtower claims the TLC on chain once the commitment delay has passed.
      await fiber.user.settleInvoice(paymentHash, preimage);
      const done = await waitForSwap(hub, swap.id, (s) => s.state === SWAP_STATE.SUCCEEDED || s.state === SWAP_STATE.FAILED, ON_CHAIN_TIMEOUT_MS, POLL_MS);
      expect(done).toMatchObject({ state: SWAP_STATE.SUCCEEDED, refunded: false });
      expect(done.preimage).toBe(preimage);
      expect(await swapSides(e2e.nodes, SWAP_DIRECTION.LN_TO_FIBER).holdInvoiceStatus(paymentHash)).toBe("SETTLED");
      await paying;
    },
    30 * MS_PER_MINUTE,
  );
});
