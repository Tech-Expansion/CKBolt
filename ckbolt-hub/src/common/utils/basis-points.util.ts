import { BASIS_POINTS_PER_WHOLE } from "../constants/pricing.constants";
import { ceilDiv } from "./amount.util";

/** `bps` basis points of `amount`, rounded up: a fee limit on a small payment with a nonzero rate is never 0. */
export const basisPointsOfCeil = (amount: bigint, bps: number): bigint => ceilDiv(amount * BigInt(bps), BASIS_POINTS_PER_WHOLE);
