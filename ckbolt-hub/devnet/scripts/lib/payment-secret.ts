import { randomPreimage, sha256Hex } from "../../../src/common/utils/hex.util";
import type { Hex32 } from "../../../src/domain/types";

/** A fresh preimage and its SHA-256 payment hash, as the user side of a swap creates them. */
export interface PaymentSecret {
  preimage: Hex32;
  paymentHash: Hex32;
}

export function newPaymentSecret(): PaymentSecret {
  const preimage = randomPreimage();
  return { preimage, paymentHash: sha256Hex(preimage) };
}
