import type { DecimalMark } from "@/lib/amount";
import type { FiberAssetId, Script } from "@/lib/hub/contract";
import { formatUnits } from "@/lib/hub/format";
import { ckbNeededToAccept } from "./channel-contribution";
import { CKB_ASSET, ckbToShannons } from "./channels";
import { dialableAddresses } from "./node-config";
import { peerIdOf, withPeerId } from "./peer-id";
import { formatTokenAmount, parseNodeId, parseTokenAmount, type FormCheck, type WalletToken } from "./tokens";
import { CHANNEL_FEE_MARGIN_CKB, CKB_DECIMALS, PEER_CHANNEL_MIN_CKB } from "./constants";

/**
 * A channel the browser node opens and funds with another Fiber node (not the CKBolt hub, which takes payments only over
 * channels it opened itself): connect_peer to its WebSocket address, then open_channel. Pure checks; the form calls the
 * node with the plan.
 */

export interface PeerChannelPlan {
  /** The multiaddr to dial, with the peer's /p2p/ id. */
  address: string;
  peerId: string;
  /** The channel's token (CKB or a token the hub lists). */
  asset: FiberAssetId;
  fundingAmount: bigint;
  udtTypeScript: Script | null;
}

export const PEER_CHANNEL_MESSAGE = {
  NODE_ID: "Enter a node id: 66 hex characters, starting with 02 or 03.",
  OWN_NODE: "This is your own node. Enter another node's id.",
  HUB: "That is the CKBolt hub. Use Open with the hub instead.",
  AMOUNT: (symbol: string) => `Enter an amount of ${symbol} above zero.`,
  ADDRESS: "Enter the node's WebSocket address, such as /dns4/host/tcp/443/wss.",
  ADDRESS_TLS: "On this https page only TLS addresses work (/wss).",
  ADDRESS_OTHER_NODE: "This address names another node than this id.",
  MIN_CKB: `Put in at least ${PEER_CHANNEL_MIN_CKB} CKB: 99 stay as the channel's reserve.`,
  SHORT_OF_CKB: (needed: string) => `Your node needs ${needed} CKB on chain for this. Add funds first.`,
  SHORT_OF_TOKEN: (held: string) => `Your node holds ${held} on chain. Add more first.`,
} as const;

const P2P_ID = /\/p2p\/([^/]+)/;

export interface PeerChannelInput {
  nodeId: string;
  address: string;
  amount: string;
  token: WalletToken;
  ownNodeId: string | null;
  /** Every id the hub is known by (hubNodeIdsOf): a channel with the hub must come from the hub. */
  hubNodeIds: readonly string[];
  /** Shannons the node holds on chain, or null until read. */
  balance: bigint | null;
  /** Base units of the chosen token the node holds on chain; null for CKB or while unknown (fnn checks it then). */
  tokenBalance: bigint | null;
  /** An https page dials TLS WebSocket addresses only. */
  secureOnly: boolean;
  decimalMark?: DecimalMark;
}

/**
 * What the node needs on chain for a channel it funds: a CKB channel's amount plus the fee margin; a token channel's
 * CKB reserve plus the margin (the token itself comes from the node's token cells, which fnn checks).
 */
export function ckbNeededToOpen(token: WalletToken, fundingAmount: bigint): bigint {
  if (token.id === CKB_ASSET) return fundingAmount + ckbToShannons(CHANNEL_FEE_MARGIN_CKB);
  return ckbToShannons(ckbNeededToAccept(token.id, 0));
}

/** The visitor's input as a plan, or the field that is wrong and why. */
export function checkPeerChannel(input: PeerChannelInput): FormCheck<PeerChannelPlan, "nodeId" | "address" | "amount"> {
  const peerId = parseNodeId(input.nodeId);
  if (!peerId) return { ok: false, field: "nodeId", error: PEER_CHANNEL_MESSAGE.NODE_ID };
  if (input.ownNodeId && peerId === input.ownNodeId) return { ok: false, field: "nodeId", error: PEER_CHANNEL_MESSAGE.OWN_NODE };
  if (input.hubNodeIds.includes(peerId)) return { ok: false, field: "nodeId", error: PEER_CHANNEL_MESSAGE.HUB };

  const address = input.address.trim();
  if (dialableAddresses([address], false).length === 0) return { ok: false, field: "address", error: PEER_CHANNEL_MESSAGE.ADDRESS };
  if (dialableAddresses([address], input.secureOnly).length === 0) return { ok: false, field: "address", error: PEER_CHANNEL_MESSAGE.ADDRESS_TLS };
  const named = P2P_ID.exec(address)?.[1];
  if (named && named !== peerIdOf(peerId)) return { ok: false, field: "address", error: PEER_CHANNEL_MESSAGE.ADDRESS_OTHER_NODE };

  const fundingAmount = parseTokenAmount(input.amount, input.token.decimals, input.decimalMark);
  if (fundingAmount === null) return { ok: false, field: "amount", error: PEER_CHANNEL_MESSAGE.AMOUNT(input.token.symbol) };
  if (input.token.id === CKB_ASSET && fundingAmount < ckbToShannons(PEER_CHANNEL_MIN_CKB)) {
    return { ok: false, field: "amount", error: PEER_CHANNEL_MESSAGE.MIN_CKB };
  }
  if (input.token.id !== CKB_ASSET && input.tokenBalance !== null && fundingAmount > input.tokenBalance) {
    return { ok: false, field: "amount", error: PEER_CHANNEL_MESSAGE.SHORT_OF_TOKEN(formatTokenAmount(input.tokenBalance, input.token)) };
  }
  const needed = ckbNeededToOpen(input.token, input.token.id === CKB_ASSET ? fundingAmount : BigInt(0));
  if (input.balance === null || input.balance < needed) {
    return { ok: false, field: "amount", error: PEER_CHANNEL_MESSAGE.SHORT_OF_CKB(formatUnits(needed.toString(), CKB_DECIMALS)) };
  }
  return { ok: true, value: { address: withPeerId(address, peerId), peerId, asset: input.token.id, fundingAmount, udtTypeScript: input.token.udtTypeScript } };
}
