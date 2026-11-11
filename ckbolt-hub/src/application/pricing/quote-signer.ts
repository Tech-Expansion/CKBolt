/** Signs and checks quote messages. The pricing module binds Ed25519QuoteSigner; tests may bind their own. */
export interface QuoteSigner {
  /** The hub's public key as lowercase hex: `Quote.hubPubkey`. */
  readonly publicKeyHex: string;
  /** Signature over the UTF-8 bytes of `message`, as lowercase hex. */
  sign(message: string): string;
  /** True when `signatureHex` is a valid signature of `message` by `publicKeyHex`. Never throws. */
  verify(message: string, signatureHex: string, publicKeyHex: string): boolean;
}

export const QUOTE_SIGNER = Symbol("QUOTE_SIGNER");
