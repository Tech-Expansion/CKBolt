import { CKB_FAUCET, MUTINYNET_FAUCET, RUSD_FAUCET_URL, SERVICE } from "../lib/constants";
import type { DeploySettings } from "../lib/settings";
import type { FundingAddresses } from "./addresses.step";

/** What the operator does by hand (logins and wallets a script may not use), with the addresses filled in. */

const UNKNOWN_ADDRESS = "(start the node and run `testnet addresses`)";
const groupThousands = (value: bigint): string => value.toLocaleString("en-US");

/**
 * The on-chain sats lnd-hub needs: its channel to the LSP (the pushed part included: the opener funds all of it), the
 * demo wallet's funding when the demo runs, and the reserve.
 */
export function lndHubOnchainNeed(settings: DeploySettings, demo: boolean): bigint {
  const { lspChannelSats, demoWalletSats, onchainReserveSats } = settings.lightning;
  return lspChannelSats + (demo ? demoWalletSats : 0n) + onchainReserveSats;
}

export function handSteps(settings: DeploySettings, addresses: FundingAddresses): string[] {
  const lndHub = addresses.lnd.find((node) => node.service === SERVICE.LND_HUB)?.address ?? UNKNOWN_ADDRESS;
  const fnnHub = addresses.fnn.find((node) => node.service === SERVICE.FNN_HUB)?.address ?? UNKNOWN_ADDRESS;
  const fnnDemo = addresses.fnn.find((node) => node.service === SERVICE.FNN_DEMO)?.address;
  const demo = addresses.lnd.some((node) => node.service === SERVICE.LND_DEMO);
  const need = lndHubOnchainNeed(settings, demo);
  return [
    "Hand steps (a script may not do these):",
    "",
    `1. Mutinynet sats for lnd-hub (GitHub login, once per day of funding):`,
    `   - Open ${MUTINYNET_FAUCET.URL} and log in with GitHub.`,
    `   - "On-chain": send ${groupThousands(need)} sats to ${lndHub}`,
    `     (the faucet allows ${groupThousands(MUTINYNET_FAUCET.DAILY_BUDGET_SATS)} sats per 24 h for on-chain, channels and Lightning together).`,
    `   - Wait about 3 minutes (6 blocks of 30 s), then run: npm --prefix deploy run testnet -- channels`,
    "",
    `2. RUSD (optional, for RUSD swaps): RUSD comes only through a browser wallet.`,
    `   - Open ${RUSD_FAUCET_URL}, connect JoyID, claim (20 RUSD per click, repeat as needed).`,
    `   - In JoyID, send the RUSD to fnn-hub: ${fnnHub}`,
    ...(fnnDemo ? [`     and, for the demo wallet's RUSD, to fnn-demo: ${fnnDemo}`] : []),
    `   - Then set DEPLOY_FIBER_RELAY_CHANNEL_RUSD (and DEPLOY_FIBER_DEMO_CHANNEL_RUSD) in deploy/deploy.env and run channels again.`,
    "",
    `3. Only if the scripted CKB claim failed: claim at ${CKB_FAUCET.WEB_URL} for ${fnnHub}`,
    ...(fnnDemo ? [`   and for ${fnnDemo}`] : []),
  ];
}
