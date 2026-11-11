import type { BridgeErrorCode } from "./bridge-protocol";

/**
 * A request over the bridge the node refuses or could not do, with the bridge's error code and a sentence for the page.
 * The bridge server answers it as is; any other error becomes `node_error`.
 */
export class NodeRequestError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NodeRequestError";
  }
}
