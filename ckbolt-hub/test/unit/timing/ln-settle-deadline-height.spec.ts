import { randomBytes } from "node:crypto";
import { LND_DEFAULT_HOLD_EXPIRY_DELTA_BLOCKS } from "../../../src/common/constants/protocol.constants";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import { lnSettleDeadlineHeight } from "../../../src/domain/timing/timing.policy";
import { FakeClock, FakeLightningNetwork } from "../../fakes";
import { profile, profileWith } from "./timing.fixtures";

/**
 * ln_to_fiber: the last height at which the hub can still settle the incoming HTLC. LND auto-cancels an accepted hold
 * invoice at expiry_height - holdexpirydelta (lnd.md 2.4, default 18: expiry 150 was ACCEPTED at 131 and CANCELED at
 * 132). The delta is the hub LND's setting, so it comes from the profile (LND_HOLD_EXPIRY_DELTA_BLOCKS).
 */
describe("timing: lnSettleDeadlineHeight", () => {
  const p = profile("regtest");

  it("matches LND's tested run: HTLC expiry 150 -> last settle height 131", () => {
    expect(lnSettleDeadlineHeight(p, 150)).toBe(131);
  });

  it.each([24, 180, 1_861, 800_115])("is one block before the auto-cancel height for expiry %d", (expiry) => {
    expect(lnSettleDeadlineHeight(p, expiry)).toBe(expiry - LND_DEFAULT_HOLD_EXPIRY_DELTA_BLOCKS - 1);
  });

  it("is a whole height and moves one for one with the HTLC expiry", () => {
    expect(Number.isInteger(lnSettleDeadlineHeight(p, 1_000))).toBe(true);
    expect(lnSettleDeadlineHeight(p, 1_001) - lnSettleDeadlineHeight(p, 1_000)).toBe(1);
  });

  it("follows the configured holdexpirydelta: 40 blocks moves the deadline 22 blocks earlier than LND's default", () => {
    // 150 - 40 - 1 = 109, against 131 with the default 18.
    expect(lnSettleDeadlineHeight(profileWith("regtest", { lndHoldExpiryDeltaBlocks: 40 }), 150)).toBe(109);
  });

  describe("against a node that auto-cancels like LND", () => {
    const START_HEIGHT = 107;
    const CLTV_EXPIRY = 43; // HTLC expiry 150, as in the tested run

    async function acceptedHoldInvoice(holdExpiryDeltaBlocks = LND_DEFAULT_HOLD_EXPIRY_DELTA_BLOCKS) {
      const net = new FakeLightningNetwork("regtest", new FakeClock(), START_HEIGHT);
      net.holdExpiryDeltaBlocks = holdExpiryDeltaBlocks;
      const hub = net.node("hub");
      const user = net.node("user");
      const preimage = randomBytes(32).toString("hex");
      const hash = sha256Hex(preimage);
      const { paymentRequest } = await hub.createHoldInvoice({
        paymentHash: hash,
        amountSats: 1_000n,
        expirySeconds: 600,
        cltvExpiry: CLTV_EXPIRY,
        memo: "deadline",
      });
      await user.payInvoice({ paymentRequest, maxFeeSats: 10n, cltvLimit: 500, timeoutSeconds: 60 });
      const status = await hub.lookupInvoice(hash);
      const earliest = Math.min(...(status?.htlcExpiryHeights ?? []));
      const deadline = lnSettleDeadlineHeight(profileWith("regtest", { lndHoldExpiryDeltaBlocks: holdExpiryDeltaBlocks }), earliest);
      return { net, hub, hash, preimage, deadline };
    }

    it("the hub can still settle at the deadline height", async () => {
      const { net, hub, hash, preimage, deadline } = await acceptedHoldInvoice();
      expect(deadline).toBe(131);

      net.mineBlocks(deadline - net.blockHeight);
      expect((await hub.lookupInvoice(hash))?.state).toBe("ACCEPTED");
      await hub.settleInvoice(preimage);
      expect((await hub.lookupInvoice(hash))?.state).toBe("SETTLED");
    });

    it("one block after the deadline the invoice is cancelled and can no longer be settled", async () => {
      const { net, hub, hash, preimage, deadline } = await acceptedHoldInvoice();

      net.mineBlocks(deadline + 1 - net.blockHeight);
      expect((await hub.lookupInvoice(hash))?.state).toBe("CANCELED");
      await expect(hub.settleInvoice(preimage)).rejects.toThrow();
    });

    it("with LND set to 40 blocks, the deadline is the last height before that node cancels", async () => {
      const { net, hub, hash, deadline } = await acceptedHoldInvoice(40);
      expect(deadline).toBe(109);

      net.mineBlocks(deadline - net.blockHeight);
      expect((await hub.lookupInvoice(hash))?.state).toBe("ACCEPTED");
      net.mineBlocks(1);
      expect((await hub.lookupInvoice(hash))?.state).toBe("CANCELED");
    });
  });
});
