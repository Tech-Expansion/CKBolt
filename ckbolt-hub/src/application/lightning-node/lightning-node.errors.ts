import { HttpStatus } from "@nestjs/common";
import { API_ERROR_CODE } from "../../common/constants/api.constants";
import { CHANNEL_OPEN_QUEUE_FULL_RETRY_AFTER_SECONDS } from "../../common/constants/channel-opens.constants";
import { LN_INBOUND_CHANNELS_FULL_RETRY_AFTER_SECONDS } from "../../common/constants/lightning-node.constants";
import { HubError, RateLimitedError } from "../../common/errors/hub.error";

/** "1 Lightning channel", "2 Lightning channels". */
const channels = (count: number): string => `${count} Lightning channel${count === 1 ? "" : "s"}`;

/** How a wallet adds the hub as a peer: the hub's URIs, or where to find them when there are none to name. */
const connectHint = (uris: readonly string[]): string =>
  uris.length > 0 ? `add ${uris.join(" or ")} as a peer in your wallet` : "add the hub's node (GET /v1/lightning/node) as a peer in your wallet";

/** Every error of the hub's Lightning node routes a user can see. The only place these messages are written. */
export const LIGHTNING_NODE_ERROR = {
  /** The inbound channel routes then answer 404, as if they did not exist. */
  inboundDisabled: (): HubError =>
    new HubError("This hub does not open Lightning channels to wallets.", HttpStatus.NOT_FOUND, API_ERROR_CODE.INBOUND_DISABLED),

  tooManyFromClient: (cap: number, retryAfterSeconds: number): HubError =>
    new RateLimitedError(`This client has already had ${channels(cap)} opened in the last day. Try again later.`, retryAfterSeconds),

  tooManyForWallet: (cap: number, retryAfterSeconds: number): HubError =>
    new RateLimitedError(`The hub has already opened ${channels(cap)} to this wallet in the last day. Try again later.`, retryAfterSeconds),

  /** Every client together has had the day's channels (LN_INBOUND_MAX_PER_DAY): Retry-After is midnight UTC. */
  tooManyToday: (cap: number, retryAfterSeconds: number): HubError =>
    new RateLimitedError(`The hub has opened the ${channels(cap)} it opens to wallets in a day. Try again tomorrow (UTC).`, retryAfterSeconds),

  /** The day's push budget (LN_INBOUND_PUSH_BUDGET_SATS_PER_DAY) would be passed: Retry-After is midnight UTC. */
  pushBudgetSpent: (budgetSats: bigint, retryAfterSeconds: number): HubError =>
    new RateLimitedError(
      `The hub has put the ${budgetSats} sats it gives wallets in a day into new channels already. Try again tomorrow (UTC).`,
      retryAfterSeconds,
    ),

  tooManyOpen: (): HubError =>
    new RateLimitedError(
      "The hub has as many Lightning channels open to wallets as it allows right now. Try again later.",
      LN_INBOUND_CHANNELS_FULL_RETRY_AFTER_SECONDS,
    ),

  /** CHANNEL_OPEN_QUEUE_MAX_WAITING requests already wait for an open. */
  busy: (): HubError =>
    new RateLimitedError(
      "The hub is opening Lightning channels for other wallets right now. Try again in half a minute.",
      CHANNEL_OPEN_QUEUE_FULL_RETRY_AFTER_SECONDS,
    ),

  notConnected: (uris: readonly string[]): HubError =>
    new HubError(
      `Connect your wallet to the hub first: ${connectHint(uris)}, then ask again.`,
      HttpStatus.CONFLICT,
      API_ERROR_CODE.CONFLICT,
    ),

  channelExists: (): HubError =>
    new HubError(
      "The hub already has a channel open or opening with your wallet. Wait for it to be ready, or close it before asking again.",
      HttpStatus.CONFLICT,
      API_ERROR_CODE.CONFLICT,
    ),

  /** The hub's confirmed on-chain bitcoin does not cover the channel plus the reserve it keeps. */
  insufficientLiquidity: (): HubError =>
    new HubError(
      "The hub does not have enough confirmed bitcoin on chain to open a channel right now. Try again later.",
      HttpStatus.SERVICE_UNAVAILABLE,
      API_ERROR_CODE.INSUFFICIENT_LIQUIDITY,
    ),

  /** LND answered OpenChannelSync with an error: nothing was opened. */
  openRefused: (cause: unknown): HubError =>
    new HubError(
      "The hub's Lightning node could not open a channel to your wallet. Check that your wallet is still connected to the hub and accepts channels, then try again.",
      HttpStatus.SERVICE_UNAVAILABLE,
      API_ERROR_CODE.UPSTREAM_UNAVAILABLE,
      { cause },
    ),

  nodeUnavailable: (cause: unknown): HubError =>
    new HubError(
      "The hub's Lightning node is not answering right now. Try again in a minute.",
      HttpStatus.SERVICE_UNAVAILABLE,
      API_ERROR_CODE.UPSTREAM_UNAVAILABLE,
      { cause },
    ),
} as const;
