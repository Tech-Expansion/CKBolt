import { formatBaseUnits, type DecimalMark } from "@/lib/amount";
import type { FiberAssetId, FiberNodeAssetDto, FiberNodeDto, Script } from "@/lib/hub/contract";
import { formatUnits } from "@/lib/hub/format";
import { CKB_ASSET } from "./channels";
import { normalizeNodeId } from "./hex";
import { sameScript } from "./scripts";
import type { PeerChannelPlan } from "./peer-channel";
import { withPeerId } from "./peer-id";
import { parseTokenAmount } from "./tokens";

/**
 * A channel the browser node opens to the hub with its own on-chain tokens, offered by the hub per token
 * (GET /v1/fiber/node `assets[].peerChannels`, ckbolt-hub docs/architecture.md "Peer channels"). On fnn 0.9.1 the node
 * cannot add its tokens to a channel the hub opens (a dual-funded UDT channel is broken there), so it opens the channel
 * itself: open_channel to the hub's node id with the token's script and at least `minAmount`, private, and fnn's
 * defaults for the commitment delay and the TLC expiry (left out; the hub assumes the longest delay whatever the node
 * picks). The hub's node accepts it by itself and puts in no tokens: the node can pay the hub up to what it put in, and
 * receive back only what it has paid. The node needs the token in its UDT whitelist (the hub's entry, at its last start)
 * and about 180 CKB on chain for its side's reserve, as for any token channel.
 *
 * Only the hub channel card offers it (hub-channel-rows.ts, components/app/fiber-node/hub-channel-request.tsx); the
 * generic "Open with another node" form keeps refusing the hub (peer-channel.ts PEER_CHANNEL_MESSAGE.HUB).
 */

/** The hub's offer, checked: the least the node may put in (base units) and the token's type script. */
export interface OwnTokenOffer {
  minAmount: bigint;
  udtTypeScript: Script;
}

const DIGITS = /^\d{1,39}$/;
const U128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);

/**
 * The hub's offer for a channel the node opens itself in `asset`, or null: CKB, a hub without the field (older hubs) or
 * with null (production today), no type script, or a minimum that is not a u128 decimal string.
 */
export function ownTokenOffer(asset: Pick<FiberNodeAssetDto, "id" | "udtTypeScript"> & { peerChannels?: FiberNodeAssetDto["peerChannels"] }): OwnTokenOffer | null {
  const peer = asset.peerChannels;
  if (!peer || asset.id === CKB_ASSET || !asset.udtTypeScript) return null;
  if (typeof peer.minAmount !== "string" || !DIGITS.test(peer.minAmount)) return null;
  const minAmount = BigInt(peer.minAmount);
  return minAmount <= U128_MAX ? { minAmount, udtTypeScript: asset.udtTypeScript } : null;
}

/** Why the hub's offer, read again just before the node opens its channel, no longer lets it (each within 12 words). */
export const OWN_OFFER_MESSAGE = {
  /** The hub stopped offering it (its cap of such channels is reached, or the token no longer takes them). */
  GONE: "The hub no longer takes a channel of your own tokens. Try again later.",
  /** `min`: the hub's minimum now, with its symbol. */
  MIN: (min: string) => `The hub now asks for at least ${min}.`,
} as const;

/**
 * The hub's offer as it stands now (GET /v1/fiber/node read again just before open_channel), for a plan made from an
 * earlier read: null when it still lets the node open this channel; otherwise why not, the minimum (base units) when it
 * rose above the plan's amount. The page reads the hub once, so a hub that reached its cap of such channels (every
 * `peerChannels` null) or changed its terms since would otherwise be acted on stale: fnn-hub accepts such a channel
 * whatever the cap, which only the offer enforces.
 */
export function ownOfferChange(
  hubNow: Pick<FiberNodeDto, "nodeId" | "assets">,
  plan: Pick<PeerChannelPlan, "peerId" | "asset" | "fundingAmount" | "udtTypeScript">,
): { kind: "gone" } | { kind: "min"; minAmount: bigint } | null {
  const dto = normalizeNodeId(hubNow.nodeId) === normalizeNodeId(plan.peerId) ? hubNow.assets.find((a) => a.id === plan.asset) : undefined;
  const offer = dto ? ownTokenOffer(dto) : null;
  if (!offer || !plan.udtTypeScript || !sameScript(offer.udtTypeScript, plan.udtTypeScript)) return { kind: "gone" };
  return plan.fundingAmount < offer.minAmount ? { kind: "min", minAmount: offer.minAmount } : null;
}

/** Why an amount of the node's own tokens cannot go in (each within 12 words). */
export const OWN_TOKEN_MESSAGE = {
  AMOUNT: (min: string, symbol: string) => `Enter at least ${min} ${symbol}.`,
  MIN: (min: string, symbol: string) => `Put in at least ${min} ${symbol}.`,
  READING: (symbol: string) => `Wait until the node has read its ${symbol}.`,
  NONE: (symbol: string) => `Your node holds no ${symbol} on chain.`,
  SHORT: (held: string, symbol: string) => `Your node holds only ${held} ${symbol} on chain.`,
} as const;

export type OwnAmountCheck = { ok: true; amount: bigint } | { ok: false; error: string };

export interface OwnAmountInput {
  text: string;
  decimals: number;
  symbol: string;
  minAmount: bigint;
  /** Base units of the token the node holds on chain, or null while it is read. */
  balance: bigint | null;
  decimalMark?: DecimalMark;
}

/**
 * The amount typed for the node's own channel, in base units: a positive amount the token can hold, at least the
 * hub's minimum, and at most what the node holds on chain (read first).
 */
export function checkOwnAmount(input: OwnAmountInput): OwnAmountCheck {
  const min = formatUnits(input.minAmount.toString(), input.decimals);
  const amount = parseTokenAmount(input.text, input.decimals, input.decimalMark);
  if (amount === null) return { ok: false, error: OWN_TOKEN_MESSAGE.AMOUNT(min, input.symbol) };
  if (amount < input.minAmount) return { ok: false, error: OWN_TOKEN_MESSAGE.MIN(min, input.symbol) };
  if (input.balance === null) return { ok: false, error: OWN_TOKEN_MESSAGE.READING(input.symbol) };
  if (input.balance === BigInt(0)) return { ok: false, error: OWN_TOKEN_MESSAGE.NONE(input.symbol) };
  if (amount > input.balance) return { ok: false, error: OWN_TOKEN_MESSAGE.SHORT(formatUnits(input.balance.toString(), input.decimals), input.symbol) };
  return { ok: true, amount };
}

/**
 * An amount the page writes into the field (the hub's minimum, Max), with the locale's decimal mark, as the swap card
 * writes its amounts (lib/swap/amount.ts unitsToInputText): checkOwnAmount reads it back as written. With "." in a
 * locale whose decimal mark is ",", "1.125" would read as 1,125 tokens (lib/amount.ts normalizeAmountInput).
 */
export function ownAmountText(units: bigint, decimals: number, decimalMark: DecimalMark = "."): string {
  const text = formatBaseUnits(units, decimals);
  return decimalMark === "." ? text : text.replace(".", decimalMark);
}

/** Max for the field: everything the node holds, when that is at least the hub's minimum; null otherwise. */
export const maxOwnAmount = (balance: bigint | null, minAmount: bigint): bigint | null =>
  balance !== null && balance > BigInt(0) && balance >= minAmount ? balance : null;

/**
 * The open_channel the node sends: to the hub's node (dialled at `address` first if it is not a peer any more), in the
 * token, with `amount` of the node's own tokens. connectAndOpenChannel (peer-connect.ts) sends it private, with no
 * commitment delay or TLC expiry of its own.
 */
export function ownChannelPlan(hub: { nodeId: string; address: string | null }, asset: FiberAssetId, offer: OwnTokenOffer, amount: bigint): PeerChannelPlan {
  return {
    address: hub.address ? withPeerId(hub.address, hub.nodeId) : "",
    peerId: hub.nodeId,
    asset,
    fundingAmount: amount,
    udtTypeScript: offer.udtTypeScript,
  };
}
