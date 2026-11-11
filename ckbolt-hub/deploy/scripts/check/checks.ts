import { ASSET_METADATA, type KnownAssetId } from "../../../src/common/constants/assets.constants";
import { FIBER_CHANNEL_READY_STATE } from "../../../src/common/constants/fiber-rpc.constants";
import { HEALTH_STATUS } from "../../../src/common/constants/health.constants";
import { fromDecimalString, fromHexQuantity } from "../../../src/common/utils/amount.util";
import { ckbNetworkOfChainHash } from "../../../src/common/utils/chain.util";
import { isWebSocketMultiaddr } from "../../../src/common/utils/multiaddr.util";
import { isLocalNetworkAddress } from "../../../src/common/utils/network.util";
import { formatBaseUnits } from "../../../src/common/utils/pricing.util";
import type { Script } from "../../../src/domain/types";
import type { AssetDto, FiberNodeDto, HealthDto } from "../../../src/interfaces/http/contract/responses";
import type { BlockchainInfo } from "../lib/bitcoind";
import { isServiceUp, type ComposePublisher, type ComposeServiceState } from "../lib/compose-state";
import { CWBTC_FAUCET_URL, LND_STATE, MULTIADDR_PEER_ID_PROTOCOL, type LndService, type ServiceName } from "../lib/constants";
import { isChannelOfAsset, type FnnChannel, type FnnNodeInfo, type FnnPeer } from "../lib/fiber";
import type { LndChannel, LndInfo, LndPendingChannel, LndWalletBalance } from "../lib/lnd";
import type { FiberPeer } from "../lib/settings";

/**
 * The readiness rules of testnet:check, as pure functions of what the nodes and the hub report. Every result that is
 * not ok says the next action. `testnet <command>` in a `next` means `npm --prefix deploy run testnet -- <command>`.
 */

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  /** The part being checked: a service, "ssh", "faucets", ... */
  area: string;
  status: CheckStatus;
  summary: string;
  /** What to do about it; set for every warn and fail. */
  next?: string;
}

export const ok = (area: string, summary: string): CheckResult => ({ area, status: "ok", summary });
export const warn = (area: string, summary: string, next: string): CheckResult => ({ area, status: "warn", summary, next });
export const fail = (area: string, summary: string, next: string): CheckResult => ({ area, status: "fail", summary, next });

const EXPECTED_BTC_CHAIN = "signet";
const EXPECTED_CKB_NETWORK = "testnet";
const PERCENT = 100;
const PERCENT_DECIMALS = 2;
const BYTES_PER_GB = 1e9;
const GB_DECIMALS = 1;

const sats = (value: bigint): string => `${value.toLocaleString("en-US")} sats`;
const assetAmount = (asset: KnownAssetId, value: bigint): string => `${formatBaseUnits(value, ASSET_METADATA[asset].decimals)} ${asset}`;

/* --------------------------------------------------------------------------------------------- containers */

export function evaluateContainers(active: ReadonlySet<ServiceName>, states: ReadonlyMap<string, ComposeServiceState>): CheckResult[] {
  return [...active].map((service) => {
    const state = states.get(service);
    if (!state) return fail(service, "container not created", `testnet up ${service}`);
    if (isServiceUp(state)) return ok(service, `${state.state}${state.health ? `, ${state.health}` : ""}`);
    const summary = `${state.state}${state.health ? `, ${state.health}` : ""}`;
    if (state.health === "starting") return warn(service, summary, `wait, or read testnet logs ${service}`);
    return fail(service, summary, `testnet logs ${service}`);
  });
}

/** The hub's port must be published on a loopback address only (the operator reaches it through an SSH tunnel). */
export function evaluateHubBinding(publishers: readonly ComposePublisher[]): CheckResult {
  // Every-interface addresses (0.0.0.0, ::) are not local network addresses, so they count as exposed too.
  const exposed = publishers.filter((publisher) => !isLocalNetworkAddress(publisher.url));
  if (publishers.length === 0) return warn("hub", "publishes no port", "testnet up hub");
  if (exposed.length > 0) {
    const where = exposed.map((p) => `${p.url}:${p.publishedPort}`).join(", ");
    return fail("hub", `published on ${where}`, "publish the hub on 127.0.0.1 only (ports in docker-compose.yml)");
  }
  return ok("hub", `listens on ${publishers.map((p) => `${p.url}:${p.publishedPort}`).join(", ")} (reach it through the SSH tunnel)`);
}

/* ------------------------------------------------------------------------------------------------ bitcoind */

export function evaluateBitcoind(info: BlockchainInfo): CheckResult {
  if (info.chain !== EXPECTED_BTC_CHAIN) {
    return fail("bitcoind", `runs chain "${info.chain}", not ${EXPECTED_BTC_CHAIN}`, "check bitcoin-conf in docker-compose.yml");
  }
  const percent = (info.verificationprogress * PERCENT).toFixed(PERCENT_DECIMALS);
  if (info.initialblockdownload || info.blocks < info.headers) {
    const summary = `syncing Mutinynet: ${percent}% verified, block ${info.blocks} of ${info.headers}`;
    return warn("bitcoind", summary, "wait (the first sync takes hours); run testnet:check again");
  }
  return ok("bitcoind", `synced at block ${info.blocks} (${(info.size_on_disk / BYTES_PER_GB).toFixed(GB_DECIMALS)} GB on disk)`);
}

/* ----------------------------------------------------------------------------------------------------- LND */

/** The wallet state: null when lncli could not ask. */
export function evaluateLndState(service: LndService, state: string | null): CheckResult {
  if (state === null) return fail(service, "LND does not answer", `testnet logs ${service}`);
  if (state === LND_STATE.NON_EXISTING) return fail(service, "no wallet yet", `testnet wallet ${service}`);
  if (state === LND_STATE.LOCKED) {
    return fail(service, "wallet locked", `check secrets/wallet/${service}.password, then testnet compose -- restart ${service}`);
  }
  if (state === LND_STATE.SERVER_ACTIVE) return ok(service, "wallet unlocked, server active");
  return warn(service, `starting (state ${state}): LND waits for bitcoind to sync`, `wait, or read testnet logs ${service}`);
}

export function evaluateLndSync(service: LndService, info: LndInfo): CheckResult {
  const channels = `${info.num_active_channels} active and ${info.num_pending_channels} pending channels`;
  const summary = `block ${info.block_height}, ${info.num_peers} peers, ${channels}`;
  if (info.synced_to_chain) return ok(service, `synced: ${summary}`);
  return warn(service, `catching up with the chain: ${summary}`, "wait; run testnet:check again");
}

export function evaluateOnchain(service: LndService, balance: LndWalletBalance): CheckResult {
  return ok(service, `on-chain: ${sats(BigInt(balance.confirmed_balance))} confirmed, ${sats(BigInt(balance.unconfirmed_balance))} unconfirmed`);
}

export interface LnChannelRule {
  service: LndService;
  /** Names the channel in the report, e.g. "channel to the Megalith LSP". */
  label: string;
  peer: string;
  /** Least outbound (local) and inbound (remote) balance before a warning; 0 to skip one. */
  minLocal: bigint;
  minRemote: bigint;
  nextWhenMissing: string;
  nextWhenLowLocal: string;
  nextWhenLowRemote: string;
}

export function evaluateLnChannel(rule: LnChannelRule, channels: readonly LndChannel[], pending: readonly LndPendingChannel[]): CheckResult {
  const { service, label } = rule;
  const withPeer = channels.filter((channel) => channel.remote_pubkey === rule.peer);
  if (withPeer.length === 0) {
    return pending.some((entry) => entry.channel.remote_node_pub === rule.peer)
      ? warn(service, `${label}: opening`, "wait for confirmations; run testnet:check again")
      : fail(service, `${label}: none`, rule.nextWhenMissing);
  }
  const active = withPeer.filter((channel) => channel.active);
  if (active.length === 0) return warn(service, `${label}: inactive (peer offline?)`, "testnet channels reconnects the peer");
  const local = active.reduce((sum, channel) => sum + BigInt(channel.local_balance), 0n);
  const remote = active.reduce((sum, channel) => sum + BigInt(channel.remote_balance), 0n);
  const summary = `${label}: ${sats(local)} outbound, ${sats(remote)} inbound`;
  if (local < rule.minLocal) return warn(service, `${summary} (outbound below ${sats(rule.minLocal)})`, rule.nextWhenLowLocal);
  if (remote < rule.minRemote) return warn(service, `${summary} (inbound below ${sats(rule.minRemote)})`, rule.nextWhenLowRemote);
  return ok(service, summary);
}

export function evaluateLnPeer(service: LndService, peers: readonly string[], peer: string, label: string): CheckResult {
  return peers.includes(peer) ? ok(service, `connected to ${label}`) : warn(service, `not connected to ${label}`, "testnet channels connects it");
}

export const evaluateHubSecrets = (service: LndService, present: boolean): CheckResult =>
  present ? ok(service, "the hub's macaroon and TLS certificate are in secrets/hub") : fail(service, "no macaroon for the hub", "testnet macaroons");

/* ---------------------------------------------------------------------------------------------------- Fiber */

export function evaluateFnnNode(service: string, info: FnnNodeInfo): CheckResult {
  const network = ckbNetworkOfChainHash(info.chain_hash);
  if (network !== EXPECTED_CKB_NETWORK) {
    return fail(service, `runs on CKB ${network}, not ${EXPECTED_CKB_NETWORK}`, "check CKB_RPC_URL in the server's .env");
  }
  return ok(service, `fnn ${info.version} on CKB ${network}, node ${info.pubkey}`);
}

export function evaluateFnnWallet(service: string, shannons: bigint, minimum: bigint): CheckResult {
  const summary = `wallet holds ${assetAmount("CKB", shannons)} on chain`;
  return shannons >= minimum ? ok(service, summary) : warn(service, `${summary} (less than ${assetAmount("CKB", minimum)})`, "testnet fund");
}

export function evaluateFnnPeers(service: string, peers: readonly FnnPeer[], wanted: readonly FiberPeer[]): CheckResult[] {
  const connected = new Set(peers.map((peer) => peer.pubkey));
  return wanted.map((peer) =>
    connected.has(peer.pubkey)
      ? ok(service, `peer ${peer.address} connected`)
      : warn(service, `peer ${peer.address} not connected`, "testnet channels connects it"),
  );
}

export interface FiberChannelRule {
  service: string;
  label: string;
  asset: KnownAssetId;
  udtTypeScript: Script | null;
  nextWhenMissing: string;
}

/** `channels` are the node's channels with one peer. */
export function evaluateFiberChannel(rule: FiberChannelRule, channels: readonly FnnChannel[]): CheckResult {
  const channel = channels.find((candidate) => isChannelOfAsset(candidate, rule.udtTypeScript));
  if (!channel) return fail(rule.service, `${rule.label}: none`, rule.nextWhenMissing);
  const state = channel.state.state_name;
  if (state !== FIBER_CHANNEL_READY_STATE) {
    return warn(rule.service, `${rule.label}: ${state}`, "wait for the funding transaction to confirm; run testnet:check again");
  }
  const local = assetAmount(rule.asset, fromHexQuantity(channel.local_balance));
  const remote = assetAmount(rule.asset, fromHexQuantity(channel.remote_balance));
  return ok(rule.service, `${rule.label}: ready, ${local} outbound, ${remote} inbound`);
}

/** Browser Fiber nodes dial a WebSocket address the node announces (docker-compose.public.yml). */
export function evaluateAnnouncedAddresses(service: string, info: FnnNodeInfo): CheckResult {
  const ws = info.addresses.filter(isWebSocketMultiaddr);
  if (ws.length === 0) {
    const next = "COMPOSE_FILE must list docker-compose.public.yml and PUBLIC_IP must be set";
    return warn(service, "announces no WebSocket address: browser Fiber nodes cannot dial it", next);
  }
  return ok(service, `announces ${ws.join(", ")}`);
}

/* ------------------------------------------------------------------------------------------------------ hub */

export function evaluateHubHealth(status: number, health: HealthDto | null): CheckResult {
  if (!health) return fail("hub", `GET /v1/health answered ${status} without a health body`, "testnet logs hub");
  const lightningSync = health.lightning.synced ? `synced at ${health.lightning.blockHeight}` : "not synced";
  const lightning = `Lightning ${health.lightning.network ?? "?"} ${lightningSync}`;
  const fiber = `Fiber ${health.fiber.network ?? "?"} ${health.fiber.reachable ? `fnn ${health.fiber.version}` : "unreachable"}`;
  const summary = `hub ${health.version} ${health.status}: ${lightning}; ${fiber}; demo wallet ${health.demo.enabled ? "on" : "off"}`;
  if (health.lightning.network !== EXPECTED_BTC_CHAIN || health.fiber.network !== EXPECTED_CKB_NETWORK) {
    return fail("hub", summary, `the hub's nodes must run on ${EXPECTED_BTC_CHAIN} and CKB ${EXPECTED_CKB_NETWORK} (hub.env networks)`);
  }
  if (health.status !== HEALTH_STATUS.OK) return fail("hub", summary, "see the lnd-hub and fnn-hub lines above, or testnet logs hub");
  return ok("hub", summary);
}

/**
 * What gives fnn-hub outbound liquidity in an asset, so the hub can pay swaps out on Fiber: testnet CKB comes from the
 * scripted faucet claim, RUSD only by hand (JoyID) before `channels` opens a RUSD channel; cWBTC is not part of the kit.
 */
const FIBER_PAYOUT_NEXT: Readonly<Record<KnownAssetId, string>> = {
  CKB: "testnet fund, then testnet channels (fnn-hub needs CKB outbound in its channels)",
  RUSD: "send RUSD to fnn-hub (hand step 2, testnet steps), set DEPLOY_FIBER_RELAY_CHANNEL_RUSD, then testnet channels",
  CWBTC: `the kit opens no cWBTC channel: claim cWBTC for fnn-hub at ${CWBTC_FAUCET_URL} and open one by hand`,
};
/** Any other asset the hub serves (FIBER_ASSETS): the kit knows nothing about it. */
const OTHER_ASSET_PAYOUT_NEXT = "the kit opens no channel in this asset: send it to fnn-hub and open a channel by hand";
const fiberPayoutNext = (assetId: string): string =>
  assetId in FIBER_PAYOUT_NEXT ? FIBER_PAYOUT_NEXT[assetId as KnownAssetId] : OTHER_ASSET_PAYOUT_NEXT;
/** Lightning payouts spend lnd-hub's outbound, which `testnet balance` lowers: a larger channel or incoming swaps raise it. */
const LIGHTNING_PAYOUT_NEXT = "a larger channel to the LSP (DEPLOY_LN_LSP_CHANNEL_SATS), or BTC to CKB swaps move sats back to lnd-hub";

/**
 * One line per asset: the directions it serves and the largest payout each side can make now. The hub lists both
 * directions for every asset it serves, so the liquidity decides: a Lightning payout below `minSats`, or no Fiber payout
 * at all, is a warning. (The Fiber side has no sats threshold: converting needs a price; the fnn lines show the amounts.)
 */
export function evaluateAssets(assets: readonly AssetDto[], minSats: bigint): CheckResult[] {
  if (assets.length === 0) return [fail("hub", "GET /v1/assets lists no asset", "testnet logs hub")];
  return assets.map((asset) => {
    const lightningSats = fromDecimalString(asset.liquidity.lightningSats);
    const fiberAmount = fromDecimalString(asset.liquidity.fiberAmount);
    const fiberNext = fiberPayoutNext(asset.id);
    const summary =
      `${asset.id}: ${asset.directions.join(", ") || "no direction"}; payouts up to ${sats(lightningSats)} (to Lightning) ` +
      `and ${formatBaseUnits(fiberAmount, asset.decimals)} ${asset.symbol} (to Fiber)`;
    if (asset.directions.length === 0) return warn("hub", summary, `${fiberNext}; then ${LIGHTNING_PAYOUT_NEXT}`);
    if (fiberAmount === 0n) return warn("hub", `${summary}; no swap to ${asset.symbol} can pay out on Fiber`, fiberNext);
    if (lightningSats < minSats) return warn("hub", `${summary}; Lightning payouts below ${sats(minSats)}`, LIGHTNING_PAYOUT_NEXT);
    return ok("hub", summary);
  });
}

const peerIdSegment = `/${MULTIADDR_PEER_ID_PROTOCOL}/`;

/** GET /v1/fiber/node: what browser Fiber nodes are told to dial. null: the hub build has no such route yet. */
export function evaluateFiberNodeView(view: FiberNodeDto | null): CheckResult {
  if (!view) return warn("hub", "no GET /v1/fiber/node (a hub build before phase 3b)", "testnet sync, testnet build, testnet up hub");
  if (view.addresses.ws.length === 0) return warn("hub", "tells browsers no WebSocket address", "PUBLIC_IP and docker-compose.public.yml in the server's .env");
  const missingPeerId = view.addresses.ws.filter((address) => !address.includes(peerIdSegment));
  const summary = `browser nodes dial ${view.addresses.ws.join(", ")}; inbound channels ${view.inbound.enabled ? "on" : "off"}`;
  if (missingPeerId.length > 0) {
    return warn("hub", `${summary} (no /p2p/<peer id>)`, "the browser node needs the peer id: set FIBER_PUBLIC_WS_ADDRS in the server's .env with it");
  }
  return ok("hub", summary);
}

/* ----------------------------------------------------------------------------------------------- rendering */

const STATUS_LABEL: Readonly<Record<CheckStatus, string>> = { ok: "[ OK ]", warn: "[WARN]", fail: "[FAIL]" };
const NEXT_INDENT = " ".repeat(STATUS_LABEL.ok.length + 3);

export const failed = (results: readonly CheckResult[]): boolean => results.some((result) => result.status === "fail");

/** The report: results grouped by area in first-seen order, each warn or fail with its next action, then a summary. */
export function renderReport(title: string, results: readonly CheckResult[]): string {
  const areas = [...new Set(results.map((result) => result.area))];
  const lines = [title, "`testnet <command>` below means: npm --prefix deploy run testnet -- <command>", ""];
  for (const area of areas) {
    lines.push(area);
    for (const result of results.filter((candidate) => candidate.area === area)) {
      lines.push(`  ${STATUS_LABEL[result.status]} ${result.summary}`);
      if (result.next) lines.push(`${NEXT_INDENT}next: ${result.next}`);
    }
  }
  const count = (status: CheckStatus) => results.filter((result) => result.status === status).length;
  lines.push("", `Summary: ${count("ok")} ok, ${count("warn")} warnings, ${count("fail")} failing`);
  return lines.join("\n");
}
