import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FIBER_HELD_TLC_EARLY_FAIL_MS,
  FIBER_MIN_FINAL_EXPIRY_DELTA_MS,
  LND_MIN_INVOICE_CLTV_EXPIRY,
  MS_PER_MINUTE,
} from "../../../src/common/constants/protocol.constants";
import { CKB_GENESIS_ISSUER_PRIVATE_KEY } from "../../scripts/lib/devnet.constants";
import { loadDevnetSettings } from "../../scripts/lib/settings";

describe("loadDevnetSettings defaults", () => {
  const settings = loadDevnetSettings({});

  it("uses the dev chain's public genesis key unless overridden", () => {
    assert.equal(settings.ckb.issuerPrivateKey, CKB_GENESIS_ISSUER_PRIVATE_KEY);
  });

  it("keeps the Fiber smoke hold above fnn's release minimum and early-fail window", () => {
    assert.ok(settings.smoke.fiberFinalExpiryDeltaMs >= FIBER_MIN_FINAL_EXPIRY_DELTA_MS);
    assert.ok(settings.smoke.fiberFinalExpiryDeltaMs > FIBER_HELD_TLC_EARLY_FAIL_MS);
  });

  it("keeps the Lightning smoke CLTV at or above LND's minimum", () => {
    assert.ok(settings.smoke.lnCltvExpiryDelta >= LND_MIN_INVOICE_CLTV_EXPIRY);
  });

  it("funds wallets with more than their top-up threshold, so a funded wallet is not funded again", () => {
    assert.ok(settings.ckb.walletFundingShannons >= settings.ckb.minWalletShannons);
    assert.ok(settings.rusd.mintPerWallet >= settings.rusd.minWalletAmount);
  });

  it("can fund the channels from what a wallet receives", () => {
    assert.ok(settings.fiber.ckbChannelShannons < settings.ckb.walletFundingShannons);
    assert.ok(settings.fiber.rusdChannelAmount <= settings.rusd.mintPerWallet);
    assert.ok(settings.lightning.channelSats < settings.lightning.minWalletSats * BigInt(settings.lightning.fundingBlocksPerWallet));
  });

  it("accepts inbound RUSD channels of the size the bootstrap opens", () => {
    assert.ok(settings.rusd.autoAcceptAmount <= settings.fiber.rusdChannelAmount);
  });

  it("smoke amounts fit in one side of a balanced channel", () => {
    assert.ok(settings.smoke.fiberCkbShannons < settings.fiber.ckbChannelShannons / 2n);
    assert.ok(settings.smoke.fiberRusdAmount < settings.fiber.rusdChannelAmount / 2n);
    assert.ok(settings.smoke.lnSats < settings.lightning.channelSats / 2n);
  });

  it("keeps the balancing threshold a share below one half", () => {
    assert.ok(settings.fiber.minSideShareBps > 0n && settings.fiber.minSideShareBps <= 5_000n);
  });

  it("gives every payment at least one try and a positive wait", () => {
    assert.ok(settings.fiber.paymentAttempts >= 1);
    assert.ok(settings.waits.timeoutMs > settings.waits.pollIntervalMs);
    assert.ok(settings.waits.rpcTimeoutMs > 0);
  });
});

describe("loadDevnetSettings overrides and errors", () => {
  it("applies DEVNET_* overrides", () => {
    const settings = loadDevnetSettings({ DEVNET_LN_CHANNEL_SATS: "123456", DEVNET_WAIT_TIMEOUT_MS: "1000" });
    assert.equal(settings.lightning.channelSats, 123_456n);
    assert.equal(settings.waits.timeoutMs, 1000);
  });

  it("rejects a Lightning smoke CLTV below LND's minimum", () => {
    assert.throws(
      () => loadDevnetSettings({ DEVNET_SMOKE_LN_CLTV_DELTA: String(LND_MIN_INVOICE_CLTV_EXPIRY - 1) }),
      /DEVNET_SMOKE_LN_CLTV_DELTA must be at least/,
    );
    assert.doesNotThrow(() => loadDevnetSettings({ DEVNET_SMOKE_LN_CLTV_DELTA: String(LND_MIN_INVOICE_CLTV_EXPIRY) }));
  });

  it("rejects a Fiber final expiry delta inside fnn's early-fail window (held TLC would fail at once)", () => {
    assert.throws(
      () => loadDevnetSettings({ DEVNET_SMOKE_FIBER_FINAL_EXPIRY_DELTA_MS: String(FIBER_HELD_TLC_EARLY_FAIL_MS) }),
      /DEVNET_SMOKE_FIBER_FINAL_EXPIRY_DELTA_MS must exceed/,
    );
    assert.throws(() => loadDevnetSettings({ DEVNET_SMOKE_FIBER_FINAL_EXPIRY_DELTA_MS: String(60 * MS_PER_MINUTE) }));
  });

  it("rejects zero balancing payment attempts", () => {
    assert.throws(() => loadDevnetSettings({ DEVNET_FIBER_PAYMENT_ATTEMPTS: "0" }), /at least 1/);
  });

  it("fails loudly on a malformed override instead of using the default", () => {
    assert.throws(() => loadDevnetSettings({ DEVNET_LN_CHANNEL_SATS: "10k" }), /DEVNET_LN_CHANNEL_SATS=10k/);
    assert.throws(() => loadDevnetSettings({ DEVNET_CKB_ISSUER_KEY: "0xdead" }), /DEVNET_CKB_ISSUER_KEY/);
  });
});
