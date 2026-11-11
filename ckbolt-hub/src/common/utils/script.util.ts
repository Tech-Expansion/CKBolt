import type { Script } from "../../domain/types";

/** Two CKB scripts are the same when code hash, hash type and args match; hex is compared without regard to case. */
export const sameScript = (a: Script, b: Script): boolean =>
  a.codeHash.toLowerCase() === b.codeHash.toLowerCase() && a.hashType === b.hashType && a.args.toLowerCase() === b.args.toLowerCase();

/** Two Fiber assets are the same: both CKB (no UDT type script) or the same UDT type script. */
export const sameAssetScript = (a: Script | null, b: Script | null): boolean =>
  a === null || b === null ? a === b : sameScript(a, b);
