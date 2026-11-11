import { HttpStatus } from "@nestjs/common";
import { API_ERROR_CODE } from "../../common/constants/api.constants";
import { CHANNEL_OPEN_QUEUE_FULL_RETRY_AFTER_SECONDS } from "../../common/constants/channel-opens.constants";
import { INBOUND_CHANNELS_FULL_RETRY_AFTER_SECONDS } from "../../common/constants/fiber-node.constants";
import { HubError, RateLimitedError } from "../../common/errors/hub.error";
import { formatBaseUnits } from "../../common/utils/pricing.util";
import type { FiberAssetId } from "../../domain/types";
import type { InboundOffer } from "./fiber-node.contract";

const formatOffer = (offer: InboundOffer): string => `${formatBaseUnits(offer.amount, offer.asset.decimals)} ${offer.asset.symbol}`;

/** Every error of the hub's Fiber node routes a user can see. The only place these messages are written. */
export const FIBER_NODE_ERROR = {
  /** The routes then answer 404, as if they did not exist. */
  inboundDisabled: (): HubError =>
    new HubError("This hub does not open inbound channels.", HttpStatus.NOT_FOUND, API_ERROR_CODE.INBOUND_DISABLED),

  assetNotOffered: (asset: FiberAssetId): HubError =>
    new HubError(
      `The hub does not open ${asset} inbound channels on its network. Pick an asset the hub lists for inbound channels.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      API_ERROR_CODE.ASSET_UNAVAILABLE,
    ),

  notConnected: (): HubError =>
    new HubError(
      "Your Fiber node is not connected to the hub's Fiber node. Connect it to one of the hub node's addresses, then ask again.",
      HttpStatus.CONFLICT,
      API_ERROR_CODE.CONFLICT,
    ),

  channelExists: (asset: FiberAssetId): HubError =>
    new HubError(
      `The hub already has a ${asset} channel open or opening to your Fiber node. Wait for it to be ready.`,
      HttpStatus.CONFLICT,
      API_ERROR_CODE.CONFLICT,
    ),

  tooManyFromClient: (cap: number, retryAfterSeconds: number): HubError =>
    new RateLimitedError(`This client has already had ${cap} inbound channels opened in the last day. Try again later.`, retryAfterSeconds),

  tooManyForNode: (cap: number, retryAfterSeconds: number): HubError =>
    new RateLimitedError(`The hub has already opened ${cap} inbound channels to this Fiber node in the last day. Try again later.`, retryAfterSeconds),

  /** Every client together has had the day's inbound channels (FIBER_INBOUND_MAX_PER_DAY): Retry-After is midnight UTC. */
  tooManyToday: (cap: number, retryAfterSeconds: number): HubError =>
    new RateLimitedError(`The hub has opened the ${cap} inbound channels it opens in a day. Try again tomorrow (UTC).`, retryAfterSeconds),

  tooManyOpen: (): HubError =>
    new RateLimitedError(
      "The hub has as many inbound channels open as it allows right now. Try again later.",
      INBOUND_CHANNELS_FULL_RETRY_AFTER_SECONDS,
    ),

  /** CHANNEL_OPEN_QUEUE_MAX_WAITING requests already wait for an open. */
  busy: (): HubError =>
    new RateLimitedError(
      "The hub is opening inbound channels for other nodes right now. Try again in half a minute.",
      CHANNEL_OPEN_QUEUE_FULL_RETRY_AFTER_SECONDS,
    ),

  /** The hub keeps its Fiber liquidity for swap payouts. */
  insufficientLiquidity: (offer: InboundOffer): HubError =>
    new HubError(
      `The hub cannot fund a ${formatOffer(offer)} inbound channel right now without short-changing swap payouts. Try again later.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      API_ERROR_CODE.INSUFFICIENT_LIQUIDITY,
    ),

  /** fnn answered open_channel with an error: nothing was opened. */
  openRefused: (cause: unknown): HubError =>
    new HubError(
      "The hub's Fiber node could not open a channel to your node. Check that your node is still connected, then try again.",
      HttpStatus.SERVICE_UNAVAILABLE,
      API_ERROR_CODE.UPSTREAM_UNAVAILABLE,
      { cause },
    ),

  nodeUnavailable: (cause: unknown): HubError =>
    new HubError(
      "The hub's Fiber node is not answering right now. Try again in a minute.",
      HttpStatus.SERVICE_UNAVAILABLE,
      API_ERROR_CODE.UPSTREAM_UNAVAILABLE,
      { cause },
    ),
} as const;
