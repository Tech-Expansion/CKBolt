import { DATABASE_PREFIX, STORAGE_PREFIX } from "./constants";
import { parseKeystore, serializeKeystore, type KeystoreRecord } from "./keystore";

/** The part of the Web Storage API the node page uses; injectable so tests can use a map. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `<prefix>:<network>:<name>`: one namespace per network, so a testnet key never meets another network. */
export const storageKey = (network: string, name: string): string => `${STORAGE_PREFIX}:${network}:${name}`;

/** fiber-js's IndexedDB prefix for a node: per network and per key, so importing another key starts a fresh database. */
export const databasePrefix = (network: string, tag: string): string => `${DATABASE_PREFIX}/${network}/${tag}`;

/** A Web Storage area, or null when the browser blocks it (private mode, storage disabled). */
export function webStore(area: "localStorage" | "sessionStorage"): KeyValueStore | null {
  try {
    const store = globalThis[area];
    return store ?? null;
  } catch {
    return null;
  }
}

/** Where the encrypted node keys live for one network. */
export class KeystoreRepository {
  private readonly key: string;

  constructor(
    private readonly store: KeyValueStore,
    private readonly network: string,
    name: string,
  ) {
    this.key = storageKey(network, name);
  }

  load(): KeystoreRecord | null {
    const text = this.store.getItem(this.key);
    return text === null ? null : parseKeystore(text, this.network);
  }

  /** True when something is stored that this app cannot read (another version, or edited by hand). */
  hasUnreadable(): boolean {
    return this.store.getItem(this.key) !== null && this.load() === null;
  }

  save(record: KeystoreRecord): void {
    this.store.setItem(this.key, serializeKeystore(record));
  }

  remove(): void {
    this.store.removeItem(this.key);
  }
}
