import { ASSET_METADATA } from "../../../src/common/constants/assets.constants";
import {
  FIBER_HELD_TLC_EARLY_FAIL_MS,
  LND_MIN_INVOICE_CLTV_EXPIRY,
  MS_PER_HOUR,
  MS_PER_SECOND,
  SATS_PER_BTC,
} from "../../../src/common/constants/protocol.constants";
import { baseUnitsPerWhole } from "../../../src/common/utils/pricing.util";
import { CKB_GENESIS_ISSUER_PRIVATE_KEY, LND_WALLET_SYNC_RETRY_SECONDS } from "./devnet.constants";
import { readAmount, readCount, readPrivateKey, type Env } from "./env";

/**
 * Tunables of the devnet bootstrap and smoke test. Defaults suit a laptop; every value can be overridden with the
 * DEVNET_* variable named next to it. Amounts are base units: sats, shannons (1 CKB = 10^8) or RUSD units (10^-8).
 */
export interface DevnetSettings {
  lightning: {
    /** Regtest blocks mined to each LND wallet before the maturity blocks (DEVNET_LN_FUNDING_BLOCKS). */
    fundingBlocksPerWallet: number;
    /** A wallet below this confirmed balance is funded again (DEVNET_LN_MIN_WALLET_SATS). */
    minWalletSats: bigint;
    /** Capacity of each channel, hub->user and user->hub (DEVNET_LN_CHANNEL_SATS). */
    channelSats: bigint;
    /** Blocks mined after opening channels (DEVNET_LN_CONFIRMATION_BLOCKS). */
    confirmationBlocks: number;
  };
  ckb: {
    /** Genesis key that funds the fnn wallets and issues the RUSD stand-in (DEVNET_CKB_ISSUER_KEY). */
    issuerPrivateKey: string;
    /** CKB sent to an fnn wallet that runs low (DEVNET_CKB_WALLET_FUNDING_SHANNONS). */
    walletFundingShannons: bigint;
    /** An fnn wallet below this balance is funded (DEVNET_CKB_MIN_WALLET_SHANNONS). */
    minWalletShannons: bigint;
  };
  rusd: {
    /** RUSD stand-in minted to an fnn wallet that runs low (DEVNET_RUSD_MINT_PER_WALLET). */
    mintPerWallet: bigint;
    /** An fnn wallet below this RUSD balance gets more (DEVNET_RUSD_MIN_WALLET). */
    minWalletAmount: bigint;
    /** fnn auto-accepts inbound RUSD channels funded with at least this (DEVNET_RUSD_AUTO_ACCEPT). */
    autoAcceptAmount: bigint;
  };
  fiber: {
    /** Funding of the hub's CKB channel to the user node (DEVNET_FIBER_CKB_CHANNEL_SHANNONS). */
    ckbChannelShannons: bigint;
    /** Funding of the hub's RUSD channel to the user node (DEVNET_FIBER_RUSD_CHANNEL). */
    rusdChannelAmount: bigint;
    /** A side holding less than this share of a channel is topped up to half (DEVNET_FIBER_MIN_SIDE_SHARE_BPS). */
    minSideShareBps: bigint;
    /** Tries for a balancing payment while the new channel reaches the routing graph (DEVNET_FIBER_PAYMENT_ATTEMPTS). */
    paymentAttempts: number;
    /** Expiry of the invoices behind balancing payments (DEVNET_FIBER_INVOICE_EXPIRY_SECONDS). */
    invoiceExpirySeconds: number;
  };
  smoke: {
    lnSats: bigint; // DEVNET_SMOKE_LN_SATS
    lnCltvExpiryDelta: number; // DEVNET_SMOKE_LN_CLTV_DELTA
    lnFeeLimitSats: bigint; // DEVNET_SMOKE_LN_FEE_LIMIT_SATS
    lnPayTimeoutSeconds: number; // DEVNET_SMOKE_LN_PAY_TIMEOUT_SECONDS
    invoiceExpirySeconds: number; // DEVNET_SMOKE_INVOICE_EXPIRY_SECONDS
    /** How long a payment stays held before the smoke test settles it (DEVNET_SMOKE_HOLD_MS). */
    holdMs: number;
    fiberCkbShannons: bigint; // DEVNET_SMOKE_FIBER_CKB_SHANNONS
    fiberRusdAmount: bigint; // DEVNET_SMOKE_FIBER_RUSD
    /** Must exceed fnn's early-fail window for held TLCs (DEVNET_SMOKE_FIBER_FINAL_EXPIRY_DELTA_MS). */
    fiberFinalExpiryDeltaMs: number;
  };
  waits: {
    timeoutMs: number; // DEVNET_WAIT_TIMEOUT_MS
    pollIntervalMs: number; // DEVNET_POLL_INTERVAL_MS
    rpcTimeoutMs: number; // DEVNET_RPC_TIMEOUT_MS
    stackStartSeconds: number; // DEVNET_STACK_START_SECONDS
  };
  /** Catching LND up after bitcoind lost blocks in an unclean Docker stop (README, Troubleshooting). */
  chainHeal: {
    /** How long LND may stay behind before its log is read for a wallet ahead of bitcoind (DEVNET_LND_STUCK_SECONDS). */
    stuckMs: number;
    /** Lines of each LND log read for that (DEVNET_LND_LOG_TAIL_LINES). */
    logTailLines: number;
    /** Most blocks the doubling batches may add in one run; 0 turns them off (DEVNET_MAX_CATCH_UP_BLOCKS). */
    maxCatchUpBlocks: number;
  };
}

const SHANNONS_PER_CKB = baseUnitsPerWhole(ASSET_METADATA.CKB.decimals);
const RUSD_UNITS_PER_RUSD = baseUnitsPerWhole(ASSET_METADATA.RUSD.decimals);
const ckb = (whole: bigint): bigint => whole * SHANNONS_PER_CKB;
const rusd = (whole: bigint): bigint => whole * RUSD_UNITS_PER_RUSD;

export function loadDevnetSettings(env: Env = process.env): DevnetSettings {
  const settings: DevnetSettings = {
    lightning: {
      fundingBlocksPerWallet: readCount(env, "DEVNET_LN_FUNDING_BLOCKS", 5),
      minWalletSats: readAmount(env, "DEVNET_LN_MIN_WALLET_SATS", SATS_PER_BTC),
      channelSats: readAmount(env, "DEVNET_LN_CHANNEL_SATS", 10_000_000n),
      confirmationBlocks: readCount(env, "DEVNET_LN_CONFIRMATION_BLOCKS", 6),
    },
    ckb: {
      issuerPrivateKey: readPrivateKey(env, "DEVNET_CKB_ISSUER_KEY", CKB_GENESIS_ISSUER_PRIVATE_KEY),
      walletFundingShannons: readAmount(env, "DEVNET_CKB_WALLET_FUNDING_SHANNONS", ckb(1_000_000n)),
      minWalletShannons: readAmount(env, "DEVNET_CKB_MIN_WALLET_SHANNONS", ckb(300_000n)),
    },
    rusd: {
      mintPerWallet: readAmount(env, "DEVNET_RUSD_MINT_PER_WALLET", rusd(1_000_000n)),
      minWalletAmount: readAmount(env, "DEVNET_RUSD_MIN_WALLET", rusd(200_000n)),
      autoAcceptAmount: readAmount(env, "DEVNET_RUSD_AUTO_ACCEPT", rusd(1n)),
    },
    fiber: {
      ckbChannelShannons: readAmount(env, "DEVNET_FIBER_CKB_CHANNEL_SHANNONS", ckb(200_000n)),
      rusdChannelAmount: readAmount(env, "DEVNET_FIBER_RUSD_CHANNEL", rusd(100_000n)),
      minSideShareBps: readAmount(env, "DEVNET_FIBER_MIN_SIDE_SHARE_BPS", 2_500n),
      paymentAttempts: readCount(env, "DEVNET_FIBER_PAYMENT_ATTEMPTS", 10),
      invoiceExpirySeconds: readCount(env, "DEVNET_FIBER_INVOICE_EXPIRY_SECONDS", 600),
    },
    smoke: {
      lnSats: readAmount(env, "DEVNET_SMOKE_LN_SATS", 10_000n),
      lnCltvExpiryDelta: readCount(env, "DEVNET_SMOKE_LN_CLTV_DELTA", 40),
      lnFeeLimitSats: readAmount(env, "DEVNET_SMOKE_LN_FEE_LIMIT_SATS", 100n),
      lnPayTimeoutSeconds: readCount(env, "DEVNET_SMOKE_LN_PAY_TIMEOUT_SECONDS", 60),
      invoiceExpirySeconds: readCount(env, "DEVNET_SMOKE_INVOICE_EXPIRY_SECONDS", 600),
      holdMs: readCount(env, "DEVNET_SMOKE_HOLD_MS", 5 * MS_PER_SECOND),
      fiberCkbShannons: readAmount(env, "DEVNET_SMOKE_FIBER_CKB_SHANNONS", ckb(100n)),
      fiberRusdAmount: readAmount(env, "DEVNET_SMOKE_FIBER_RUSD", rusd(10n)),
      fiberFinalExpiryDeltaMs: readCount(env, "DEVNET_SMOKE_FIBER_FINAL_EXPIRY_DELTA_MS", 6 * MS_PER_HOUR),
    },
    waits: {
      timeoutMs: readCount(env, "DEVNET_WAIT_TIMEOUT_MS", 180 * MS_PER_SECOND),
      pollIntervalMs: readCount(env, "DEVNET_POLL_INTERVAL_MS", MS_PER_SECOND),
      rpcTimeoutMs: readCount(env, "DEVNET_RPC_TIMEOUT_MS", 15 * MS_PER_SECOND),
      stackStartSeconds: readCount(env, "DEVNET_STACK_START_SECONDS", 300),
    },
    chainHeal: {
      stuckMs: readCount(env, "DEVNET_LND_STUCK_SECONDS", 15) * MS_PER_SECOND,
      logTailLines: readCount(env, "DEVNET_LND_LOG_TAIL_LINES", 200),
      maxCatchUpBlocks: readCount(env, "DEVNET_MAX_CATCH_UP_BLOCKS", 2_016),
    },
  };
  assertConsistent(settings);
  return settings;
}

function assertConsistent({ smoke, fiber, chainHeal }: DevnetSettings): void {
  if (smoke.lnCltvExpiryDelta < LND_MIN_INVOICE_CLTV_EXPIRY) {
    throw new Error(`DEVNET_SMOKE_LN_CLTV_DELTA must be at least ${LND_MIN_INVOICE_CLTV_EXPIRY} (LND's minimum)`);
  }
  if (smoke.fiberFinalExpiryDeltaMs <= FIBER_HELD_TLC_EARLY_FAIL_MS) {
    throw new Error(`DEVNET_SMOKE_FIBER_FINAL_EXPIRY_DELTA_MS must exceed ${FIBER_HELD_TLC_EARLY_FAIL_MS} ms, or fnn fails the held TLC at once`);
  }
  if (fiber.paymentAttempts < 1) throw new Error("DEVNET_FIBER_PAYMENT_ATTEMPTS must be at least 1");
  if (chainHeal.stuckMs <= LND_WALLET_SYNC_RETRY_SECONDS * MS_PER_SECOND) {
    throw new Error(
      `DEVNET_LND_STUCK_SECONDS must exceed ${LND_WALLET_SYNC_RETRY_SECONDS} (LND retries its wallet sync that often), or blocks are mined before LND saw the last ones`,
    );
  }
  if (chainHeal.logTailLines < 1) throw new Error("DEVNET_LND_LOG_TAIL_LINES must be at least 1");
}
