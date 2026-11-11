import { Inject, Injectable } from "@nestjs/common";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import {
  ED25519_KEY_TYPE,
  ED25519_PKCS8_SEED_PREFIX_HEX,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  ED25519_SPKI_KEY_PREFIX_HEX,
} from "../../common/constants/pricing.constants";
import { isHexOfBytes } from "../../common/utils/hex.util";
import type { HubConfig } from "../../config/hub.config";
import { HUB_CONFIG } from "../ports/tokens";
import type { QuoteSigner } from "./quote-signer";

const HEX = "hex";
const DER = "der";
const MESSAGE_ENCODING = "utf8";
/** Ed25519 hashes internally, so node:crypto takes no digest name. */
const NO_DIGEST = null;

const privateKeyFromSeed = (seedHex: string): KeyObject =>
  createPrivateKey({ key: Buffer.from(ED25519_PKCS8_SEED_PREFIX_HEX + seedHex, HEX), format: DER, type: "pkcs8" });

const publicKeyFromRaw = (publicKeyHex: string): KeyObject =>
  createPublicKey({ key: Buffer.from(ED25519_SPKI_KEY_PREFIX_HEX + publicKeyHex, HEX), format: DER, type: "spki" });

const rawPublicKeyHex = (privateKey: KeyObject): string =>
  createPublicKey(privateKey).export({ format: DER, type: "spki" }).subarray(-ED25519_PUBLIC_KEY_BYTES).toString(HEX);

/**
 * Ed25519 quote signatures with node:crypto. The key comes from config (`pricing.signingKeyHex`, a 32-byte seed) so
 * quotes survive a restart; without it a key is generated per process and older quotes no longer verify.
 */
@Injectable()
export class Ed25519QuoteSigner implements QuoteSigner {
  readonly publicKeyHex: string;
  private readonly privateKey: KeyObject;

  constructor(@Inject(HUB_CONFIG) config: HubConfig) {
    const seedHex = config.pricing.signingKeyHex;
    this.privateKey = seedHex ? privateKeyFromSeed(seedHex) : generateKeyPairSync(ED25519_KEY_TYPE).privateKey;
    this.publicKeyHex = rawPublicKeyHex(this.privateKey);
  }

  sign(message: string): string {
    return sign(NO_DIGEST, Buffer.from(message, MESSAGE_ENCODING), this.privateKey).toString(HEX);
  }

  verify(message: string, signatureHex: string, publicKeyHex: string): boolean {
    if (!isHexOfBytes(signatureHex, ED25519_SIGNATURE_BYTES) || !isHexOfBytes(publicKeyHex, ED25519_PUBLIC_KEY_BYTES)) return false;
    try {
      return verify(NO_DIGEST, Buffer.from(message, MESSAGE_ENCODING), publicKeyFromRaw(publicKeyHex), Buffer.from(signatureHex, HEX));
    } catch {
      return false;
    }
  }
}
