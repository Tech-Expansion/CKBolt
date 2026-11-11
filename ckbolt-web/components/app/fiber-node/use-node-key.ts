"use client";

import { useCallback, useMemo, useState } from "react";
import {
  browserKeystoreDeps,
  decryptKeys,
  encryptKeys,
  parseKeystore,
  passwordProblem,
  WrongPasswordError,
  type KeystoreRecord,
} from "@/lib/wallets/fiber-browser/keystore";
import { generateNodeKeys, type NodeKeys } from "@/lib/wallets/fiber-browser/keys";
import { KeystoreRepository, webStore } from "@/lib/wallets/fiber-browser/storage";
import { STORAGE_NAME } from "@/lib/wallets/fiber-browser/constants";

export interface NodeKey {
  /** The stored, encrypted keys, or null when this browser has none. */
  record: KeystoreRecord | null;
  /** localStorage is blocked: nothing can be kept. */
  storageBlocked: boolean;
  /** Something is stored that this app cannot read. */
  unreadable: boolean;
  /** scrypt is running. */
  busy: boolean;
  error: string | null;
  /** New keys, stored encrypted; the keys to start with, or null on error. */
  create: (password: string, confirmation: string) => Promise<NodeKeys | null>;
  unlock: (password: string) => Promise<NodeKeys | null>;
  /** Replaces the stored keys with a backup, after checking the password opens it. */
  restore: (backup: string, password: string) => Promise<NodeKeys | null>;
  /** Keeps the node id next to the keys, so the page can name the node before it is unlocked. */
  rememberNodeId: (nodeId: string) => void;
  forget: () => void;
}

const STORAGE_BLOCKED = "This browser blocks site storage, so the node key cannot be kept. Leave private mode or allow site data.";
const UNREADABLE_BACKUP = "This is not a CKBolt Fiber node backup for this network.";
const UNEXPECTED = "Something went wrong with the node key. Try again.";

const messageOf = (e: unknown): string => (e instanceof WrongPasswordError ? e.message : e instanceof Error ? e.message : UNEXPECTED);

/** The node's keys in this browser: create, unlock, restore, forget. Keys only ever leave this hook to start the node. */
export function useNodeKey(network: string): NodeKey {
  const repository = useMemo(() => {
    const store = webStore("localStorage");
    return store ? new KeystoreRepository(store, network, STORAGE_NAME.KEYSTORE) : null;
  }, [network]);
  const [record, setRecord] = useState<KeystoreRecord | null>(() => repository?.load() ?? null);
  const [unreadable, setUnreadable] = useState(() => repository?.hasUnreadable() ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(repository ? null : STORAGE_BLOCKED);

  /** Runs a key operation with the busy flag and error handling. */
  const run = useCallback(async (operation: () => Promise<NodeKeys>): Promise<NodeKeys | null> => {
    setBusy(true);
    setError(null);
    try {
      return await operation();
    } catch (e) {
      setError(messageOf(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const save = useCallback(
    (next: KeystoreRecord) => {
      repository?.save(next);
      setRecord(next);
      setUnreadable(false);
    },
    [repository],
  );

  const create = useCallback(
    (password: string, confirmation: string) =>
      run(async () => {
        if (!repository) throw new Error(STORAGE_BLOCKED);
        const problem = passwordProblem(password, confirmation);
        if (problem) throw new Error(problem);
        const keys = generateNodeKeys();
        save(await encryptKeys(keys, password, network, browserKeystoreDeps()));
        return keys;
      }),
    [run, repository, save, network],
  );

  const unlock = useCallback(
    (password: string) =>
      run(async () => {
        if (!record) throw new Error("There is no node key in this browser yet.");
        return decryptKeys(record, password, browserKeystoreDeps());
      }),
    [run, record],
  );

  const restore = useCallback(
    (backup: string, password: string) =>
      run(async () => {
        if (!repository) throw new Error(STORAGE_BLOCKED);
        const parsed = parseKeystore(backup.trim(), network);
        if (!parsed) throw new Error(UNREADABLE_BACKUP);
        const keys = await decryptKeys(parsed, password, browserKeystoreDeps());
        save(parsed);
        return keys;
      }),
    [run, repository, save, network],
  );

  const rememberNodeId = useCallback(
    (nodeId: string) => {
      if (record && record.nodeId !== nodeId) save({ ...record, nodeId });
    },
    [record, save],
  );

  const forget = useCallback(() => {
    repository?.remove();
    setRecord(null);
    setUnreadable(false);
    setError(repository ? null : STORAGE_BLOCKED);
  }, [repository]);

  return { record, storageBlocked: !repository, unreadable, busy, error, create, unlock, restore, rememberNodeId, forget };
}
