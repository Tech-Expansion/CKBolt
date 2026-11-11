import { HttpStatus } from "@nestjs/common";
import { API_ERROR_CODE } from "../../common/constants/api.constants";
import { HubError, type HubErrorOptions } from "../../common/errors/hub.error";
import type { FiberAssetId } from "../../domain/types";

/** The hub runs without demo nodes. The demo routes then answer 404, as if they did not exist. */
export class DemoDisabledError extends HubError {
  constructor() {
    super("The demo wallet is not enabled on this hub.", HttpStatus.NOT_FOUND, API_ERROR_CODE.DEMO_DISABLED);
    this.name = "DemoDisabledError";
  }
}

/** The asset is valid but not served on this hub's network, so the demo wallet cannot make an invoice for it. */
export class DemoAssetUnavailableError extends HubError {
  constructor(asset: FiberAssetId) {
    super(`This hub does not serve ${asset} on its network. Pick another asset.`, HttpStatus.UNPROCESSABLE_ENTITY, API_ERROR_CODE.ASSET_UNAVAILABLE);
    this.name = "DemoAssetUnavailableError";
  }
}

/** The swap's hold invoice is already paid, settled or cancelled. */
export class SwapNotAwaitingPaymentError extends HubError {
  constructor() {
    super("This swap is no longer waiting for a payment.", HttpStatus.CONFLICT, API_ERROR_CODE.CONFLICT);
    this.name = "SwapNotAwaitingPaymentError";
  }
}

/**
 * The swap pays out to a wallet other than the demo wallet. The demo wallet funds only swaps whose payout it receives
 * itself, or anyone could have it pay for a payout to their own wallet.
 */
export class SwapNotForDemoWalletError extends HubError {
  constructor() {
    super(
      "The demo wallet pays only swaps that pay out to the demo wallet. Pay this swap from your own wallet.",
      HttpStatus.CONFLICT,
      API_ERROR_CODE.CONFLICT,
    );
    this.name = "SwapNotForDemoWalletError";
  }
}

/** A demo node did not answer, or could not route the payment. */
export class DemoWalletUnavailableError extends HubError {
  constructor(options: HubErrorOptions = {}) {
    super(
      "The demo wallet could not complete this action right now. Try again later.",
      HttpStatus.SERVICE_UNAVAILABLE,
      API_ERROR_CODE.UPSTREAM_UNAVAILABLE,
      options,
    );
    this.name = "DemoWalletUnavailableError";
  }
}
