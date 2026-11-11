/** A price source that did not answer, or answered with something unusable. The pricing service logs and skips it. */
export class PriceSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceSourceError";
  }
}
