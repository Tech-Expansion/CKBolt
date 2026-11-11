/**
 * Facts the testnet guide (/app/guide) names: where to get test money, the Lightning wallet it walks through (Alby Hub
 * on Mutinynet, decision D2 of the phase-3c plan) and the demo's limits. They mirror
 * ../ckbolt-hub/docs/testing-testnet.md, section 2; change both together.
 */

import { CHANNEL_FEE_MARGIN_CKB, CHANNEL_RESERVE_CKB } from "@/lib/wallets/fiber-browser/constants";

/** The guide's page. */
export const GUIDE_PAGE_PATH = "/app/guide";

/** Id of the guide's "CKBolt hub" card (hub-card.tsx): where other pages send a visitor for the hub's addresses. */
export const GUIDE_HUB_ANCHOR = "hub";
export const GUIDE_HUB_HREF = `${GUIDE_PAGE_PATH}#${GUIDE_HUB_ANCHOR}`;

/** Mutinynet's faucet: on-chain sats, Lightning payments and channels to a wallet (log in with GitHub). */
export const MUTINYNET_FAUCET_URL = "https://faucet.mutinynet.com";

/** Alby Hub's own page once its container runs (the port the command below publishes). */
export const ALBY_HUB_LOCAL_URL = "http://localhost:8029";

/** Alby Hub on Mutinynet in Docker, as tested with the hub (v1.24.4). */
export const ALBY_HUB_DOCKER_RUN =
  "docker run -d --name albyhub-mutinynet --restart unless-stopped -v albyhub-mutinynet:/data -e WORK_DIR=/data -e NETWORK=signet -e MEMPOOL_API=https://mutinynet.com/api -e LDK_ESPLORA_SERVER=https://mutinynet.com/api -e LDK_GOSSIP_SOURCE=https://rgs.mutinynet.com/snapshot -p 127.0.0.1:8029:8080 ghcr.io/getalby/hub:v1.24.4";

/** Megalith, the Mutinynet node the faucet opens channels from: a wallet connects to it before asking for one. */
export const MEGALITH_PEER_URI = "03e30fda71887a916ef5548a4d02b06fe04aaa1a8de9e24134ce7f139cf79d7579@64.23.192.68:9736";

/** The channel to ask the faucet for: half of it pushed to the wallet, so it can pay and receive. */
export const FAUCET_CHANNEL = { capacitySats: "300,000", pushPercent: "50%" } as const;

/** CKB to put on the browser node: its 1,200 CKB share of the hub's channel, plus room for fees. */
export const NODE_FUNDING_CKB = "1,300";

/** CKB a channel in a token (RUSD, cWBTC) takes from the node: its reserve plus the fee margin, as the node checks it. */
export const TOKEN_CHANNEL_CKB = (CHANNEL_RESERVE_CKB.UDT + CHANNEL_FEE_MARGIN_CKB).toLocaleString("en-US");

/** The testnet hub's limits per swap (its SWAP_MIN_SATS and SWAP_MAX_SATS, decision D6). */
export const SWAP_LIMITS_SATS = { min: "1,000", max: "20,000" } as const;
