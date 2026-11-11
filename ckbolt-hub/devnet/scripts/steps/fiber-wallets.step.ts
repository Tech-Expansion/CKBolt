import { ASSET_METADATA } from "../../../src/common/constants/assets.constants";
import { formatBaseUnits } from "../../../src/common/utils/pricing.util";
import type { Script } from "../../../src/domain/types";
import { xudtAmountData, type CkbChain, type CkbOutput } from "../lib/ckb";
import type { DevnetContext, FiberNodes } from "../lib/context";
import { fromFnnScript, type FiberNode } from "../lib/fiber";
import type { RusdStandIn } from "../lib/rusd";

interface Wallet {
  node: FiberNode;
  lock: Script;
}

/**
 * Funds each fnn wallet (the node's default funding lock) with CKB and the RUSD stand-in from the genesis issuer key,
 * in one transaction. The issuer owns the xUDT, so these outputs mint it. Wallets that hold enough are left alone.
 */
export async function fundFiberWallets(ctx: DevnetContext, ckb: CkbChain, fiber: FiberNodes, rusd: RusdStandIn): Promise<void> {
  ctx.logger.step("CKB: funding the fnn wallets with CKB and the RUSD stand-in (xUDT)");
  const wallets = await Promise.all([fiber.hub, fiber.user].map(walletOf));
  const outputs: CkbOutput[] = [];
  for (const wallet of wallets) outputs.push(...(await topUps(ctx, ckb, wallet, rusd.typeScript)));
  if (outputs.length === 0) {
    ctx.logger.info("both wallets already hold CKB and RUSD");
    return;
  }
  const txHash = await ckb.send(rusd.issuer, outputs);
  ctx.logger.info(`sent ${outputs.length} outputs in ${txHash}; waiting for it to commit`);
  await ckb.waitCommitted(txHash, ctx.settings.waits.timeoutMs);
}

async function walletOf(node: FiberNode): Promise<Wallet> {
  return { node, lock: fromFnnScript((await node.nodeInfo()).default_funding_lock_script) };
}

async function topUps(ctx: DevnetContext, ckb: CkbChain, wallet: Wallet, rusdType: Script): Promise<CkbOutput[]> {
  const { ckb: ckbSettings, rusd: rusdSettings } = ctx.settings;
  const outputs: CkbOutput[] = [];
  const capacity = await ckb.capacityOf(wallet.lock);
  if (capacity < ckbSettings.minWalletShannons) {
    outputs.push({ lock: wallet.lock, capacity: ckbSettings.walletFundingShannons });
    ctx.logger.info(`${wallet.node.name}: +${formatBaseUnits(ckbSettings.walletFundingShannons, ASSET_METADATA.CKB.decimals)} CKB`);
  }
  const rusdBalance = await ckb.xudtBalanceOf(wallet.lock, rusdType);
  if (rusdBalance < rusdSettings.minWalletAmount) {
    outputs.push({ lock: wallet.lock, type: rusdType, data: xudtAmountData(rusdSettings.mintPerWallet) });
    ctx.logger.info(`${wallet.node.name}: +${formatBaseUnits(rusdSettings.mintPerWallet, ASSET_METADATA.RUSD.decimals)} RUSD`);
  }
  return outputs;
}
