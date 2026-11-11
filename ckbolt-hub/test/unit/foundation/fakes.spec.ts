import { randomBytes } from "node:crypto";
import { sha256Hex, preimageMatches } from "../../../src/common/utils/hex.util";
import { assetRegistryOf, loadHubConfig } from "../../../src/config/hub.config";
import { FakeClock, FakeFiberNetwork, FakeLightningNetwork } from "../../fakes";

const newPreimage = () => randomBytes(32).toString("hex");

describe("foundation: fakes behave like the nodes the hub relies on", () => {
  it("Lightning hold invoice: OPEN -> ACCEPTED -> SETTLED, and the payer learns the preimage", async () => {
    const net = new FakeLightningNetwork("regtest", new FakeClock(), 100);
    const hub = net.node("hub");
    const user = net.node("user");
    const preimage = newPreimage();
    const hash = sha256Hex(preimage);
    const { paymentRequest } = await hub.createHoldInvoice({ paymentHash: hash, amountSats: 1_000n, expirySeconds: 600, cltvExpiry: 80, memo: "t" });

    expect((await hub.lookupInvoice(hash))?.state).toBe("OPEN");
    expect((await user.payInvoice({ paymentRequest, maxFeeSats: 10n, cltvLimit: 500, timeoutSeconds: 60 })).state).toBe("IN_FLIGHT");
    const accepted = await hub.lookupInvoice(hash);
    expect(accepted?.state).toBe("ACCEPTED");
    expect(accepted?.htlcExpiryHeights).toEqual([180]);

    await hub.settleInvoice(preimage);
    expect((await hub.lookupInvoice(hash))?.state).toBe("SETTLED");
    expect((await user.getPayment(hash))?.preimage).toBe(preimage);
  });

  it("Lightning: LND auto-cancels an accepted hold invoice 18 blocks before HTLC expiry", async () => {
    const net = new FakeLightningNetwork("regtest", new FakeClock(), 100);
    const hub = net.node("hub");
    const user = net.node("user");
    const hash = sha256Hex(newPreimage());
    const { paymentRequest } = await hub.createHoldInvoice({ paymentHash: hash, amountSats: 1_000n, expirySeconds: 600, cltvExpiry: 80, memo: "t" });
    await user.payInvoice({ paymentRequest, maxFeeSats: 10n, cltvLimit: 500, timeoutSeconds: 60 });
    net.mineBlocks(61);
    expect((await hub.lookupInvoice(hash))?.state).toBe("ACCEPTED");
    net.mineBlocks(1);
    expect((await hub.lookupInvoice(hash))?.state).toBe("CANCELED");
    expect((await user.getPayment(hash))?.state).toBe("FAILED");
  });

  it("Fiber hold invoice: Open -> Received -> Paid; cancel refunds; early fail leaves Received with no TLC", async () => {
    const clock = new FakeClock();
    const net = new FakeFiberNetwork("devnet", clock);
    const hub = net.node("hub");
    const user = net.node("user");

    const preimage = newPreimage();
    const hash = sha256Hex(preimage);
    const { invoice } = await hub.createHoldInvoice({ paymentHash: hash, amount: 10n ** 10n, udtTypeScript: null, expirySeconds: 600, finalExpiryDeltaMs: 6 * 3_600_000, description: "t" });
    await user.payInvoice({ invoice, maxFeeAmount: 0n, tlcExpiryLimitMs: 14 * 24 * 3_600_000 });
    expect((await hub.getInvoice(hash))?.state).toBe("Received");
    expect(await hub.heldTlcs(hash, null)).toHaveLength(1);
    await hub.settleInvoice(hash, preimage);
    expect((await hub.getInvoice(hash))?.state).toBe("Paid");
    expect((await user.getPayment(hash))?.preimage).toBe(preimage);

    const hash2 = sha256Hex(newPreimage());
    const second = await hub.createHoldInvoice({ paymentHash: hash2, amount: 1n, udtTypeScript: null, expirySeconds: 600, finalExpiryDeltaMs: 6 * 3_600_000, description: "t" });
    await user.payInvoice({ invoice: second.invoice, maxFeeAmount: 0n, tlcExpiryLimitMs: 14 * 24 * 3_600_000 });
    clock.advance(9 * 3_600_000);
    net.tick();
    expect((await hub.getInvoice(hash2))?.state).toBe("Received");
    expect(await hub.heldTlcs(hash2, null)).toHaveLength(0);
    expect((await user.getPayment(hash2))?.state).toBe("Failed");
  });

  it("utilities and config load with defaults", () => {
    const p = newPreimage();
    expect(preimageMatches(p, sha256Hex(p))).toBe(true);
    const config = loadHubConfig({});
    expect(config.timing.name).toBe("regtest");
    expect(config.pricing.maxSats).toBe(100_000n);
    expect(assetRegistryOf(loadHubConfig({ CKB_NETWORK: "testnet" })).get("RUSD")?.udtTypeScript?.codeHash).toMatch(/^0x1142/);
    expect(assetRegistryOf(config).get("RUSD")).toBeNull();
  });
});
