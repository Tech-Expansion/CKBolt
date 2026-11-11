import { readTextFile, writeTextFile } from "./files";

/** A block of the regtest chain by height and hash (hex, as bitcoin-cli prints it). */
export interface ChainTip {
  height: number;
  hash: string;
}

/** Where the scripts keep the tip of their last mine. */
export interface TipStore {
  /** The recorded tip; null when none was recorded or the record cannot be read. */
  load(): Promise<ChainTip | null>;
  save(tip: ChainTip): Promise<void>;
}

const BLOCK_HASH = /^[0-9a-f]{64}$/;
const JSON_INDENT = 2;

/** The tip as JSON in a file: devnet/state/bitcoin-tip.json (deleted by `npm run reset` with the rest of state/). */
export class FileTipStore implements TipStore {
  constructor(private readonly path: string) {}

  async load(): Promise<ChainTip | null> {
    const text = await readTextFile(this.path);
    return text === undefined ? null : parseChainTip(text);
  }

  async save(tip: ChainTip): Promise<void> {
    await writeTextFile(this.path, `${JSON.stringify(tip, null, JSON_INDENT)}\n`);
  }
}

/** A recorded tip, or null for anything else: a record cut short by a crash only loses the exact heal, never `up`. */
export function parseChainTip(text: string): ChainTip | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { height, hash } = value as Partial<Record<keyof ChainTip, unknown>>;
  const valid = typeof height === "number" && Number.isSafeInteger(height) && height >= 0 && typeof hash === "string" && BLOCK_HASH.test(hash);
  return valid ? { height, hash } : null;
}
