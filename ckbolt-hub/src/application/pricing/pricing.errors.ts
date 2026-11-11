import { HttpStatus } from "@nestjs/common";
import { API_ERROR_CODE } from "../../common/constants/api.constants";
import { REQUEST_QUOTE_DIRECTIONS, SATS_UNIT_LABEL } from "../../common/constants/swap.constants";
import { HubError } from "../../common/errors/hub.error";
import { formatBaseUnits } from "../../common/utils/pricing.util";
import { lightningIsIncoming } from "../../domain/pricing";
import type { Direction, FiberAsset, QuotePurpose } from "../../domain/types";

/** What the hub can pay out, in the payout leg's unit: the asset on Fiber (ln_to_fiber) or sats (fiber_to_ln). */
const formatPayout = (direction: Direction, amount: bigint, asset: FiberAsset): string =>
  lightningIsIncoming(direction) ? `${formatBaseUnits(amount, asset.decimals)} ${asset.symbol}` : `${amount} ${SATS_UNIT_LABEL}`;

/** Every error a quote request can show the user. The only place these messages are written. */
export const PRICING_ERROR = {
  assetNotServed: (asset: string): HubError =>
    new HubError(
      `The hub does not swap ${asset} on this network. Pick one of the assets the hub lists.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      API_ERROR_CODE.ASSET_UNAVAILABLE,
    ),

  /** A request quote outside REQUEST_QUOTE_DIRECTIONS: valid input the hub does not serve (422). */
  purposeUnsupported: (purpose: QuotePurpose, direction: Direction): HubError =>
    new HubError(
      `The hub makes ${purpose} quotes for ${REQUEST_QUOTE_DIRECTIONS.join(", ")} only, not ${direction}. Leave out purpose for a ${direction} quote.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      API_ERROR_CODE.PURPOSE_UNSUPPORTED,
    ),

  amountNotPositive: (): HubError =>
    new HubError("The amount must be a positive whole number of base units.", HttpStatus.UNPROCESSABLE_ENTITY, API_ERROR_CODE.VALIDATION),

  satsOutOfRange: (sats: bigint, minSats: bigint, maxSats: bigint): HubError =>
    new HubError(
      `The Lightning side of this swap would be ${sats} sats; the hub swaps from ${minSats} to ${maxSats} sats. Change the amount.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      API_ERROR_CODE.VALIDATION,
    ),

  amountTooSmall: (): HubError =>
    new HubError(
      "This amount is too small to swap: one side would round to nothing. Use a larger amount.",
      HttpStatus.UNPROCESSABLE_ENTITY,
      API_ERROR_CODE.VALIDATION,
    ),

  noFreshPrice: (): HubError =>
    new HubError(
      "No fresh market price is available right now, so the hub cannot quote. Try again in a minute.",
      HttpStatus.SERVICE_UNAVAILABLE,
      API_ERROR_CODE.QUOTE_UNAVAILABLE,
    ),

  insufficientLiquidity: (direction: Direction, available: bigint, asset: FiberAsset): HubError =>
    new HubError(
      `The hub can pay out at most ${formatPayout(direction, available, asset)} right now. Try a smaller amount.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      API_ERROR_CODE.INSUFFICIENT_LIQUIDITY,
    ),

  balancesUnavailable: (cause?: unknown): HubError =>
    new HubError(
      "The hub cannot read its channel balances right now. Try again in a minute.",
      HttpStatus.SERVICE_UNAVAILABLE,
      API_ERROR_CODE.UPSTREAM_UNAVAILABLE,
      { cause },
    ),
} as const;
