"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { backupFileName, serializeKeystore } from "@/lib/wallets/fiber-browser/keystore";
import type { NodeKeys } from "@/lib/wallets/fiber-browser/keys";
import { BACKUP_FILE_TYPE, PASSWORD_MIN_LENGTH } from "@/lib/wallets/fiber-browser/constants";
import { InfoTip } from "../swap/info-tip";
import { primaryButton, shorten } from "../ui";
import { noteBox, pillButton, textArea, textButton, textInput } from "./styles";
import { StatusNotice } from "../status";
import { useSecretReset } from "./secret-reset";
import type { NodeKey } from "./use-node-key";

/**
 * The node key's forms, shared by the node page's key panel and the wallet popup: create, unlock, restore, back up and
 * forget. Keys leave them only to start the node.
 */

/** The stored key cannot be read: a backup replaces it. */
export function UnreadableKeyNotice({ nodeKey }: { nodeKey: NodeKey }) {
  if (!nodeKey.unreadable) return null;
  return <StatusNotice tone="error">This browser holds a node key CKBolt cannot read. Restore a backup to replace it.</StatusNotice>;
}

/** What went wrong in the last key operation; `id` lets the form that failed point at it (aria-describedby). */
export function KeyError({ nodeKey, id }: { nodeKey: NodeKey; id: string }) {
  if (!nodeKey.error) return null;
  return (
    <StatusNotice tone="error" id={id} role="alert" data-testid="fiber-node-key-error">
      {nodeKey.error}
    </StatusNotice>
  );
}

interface KeyFormProps {
  nodeKey: NodeKey;
  onKeys: (keys: NodeKeys) => void;
  /** The id of the KeyError beside the form. */
  errorId: string;
}

export function CreateKeyForm({ nodeKey, onKeys, errorId }: KeyFormProps) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const clear = () => {
    setPassword("");
    setRepeat("");
  };
  useSecretReset(clear);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const keys = await nodeKey.create(password, repeat);
    // Typed passwords never stay in the form once used, whether the key was made or not.
    clear();
    if (keys) onKeys(keys);
  };
  return (
    <form onSubmit={submit} className="space-y-4" data-testid="fiber-node-create">
      <p className="text-muted-foreground leading-relaxed">
        Its keys stay in this browser. A lost password cannot be recovered.{" "}
        <InfoTip label="About the node key" align="start">
          Its two keys are generated in this browser and stored here, encrypted with your password (scrypt and AES-GCM). CKBolt never
          sees them, and nobody can recover a lost password.
        </InfoTip>
      </p>
      <div className="space-y-2">
        <label htmlFor="fiber-node-password" className="block text-sm text-muted-foreground">
          Password, at least {PASSWORD_MIN_LENGTH} characters
        </label>
        <input
          id="fiber-node-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={!!nodeKey.error}
          aria-describedby={nodeKey.error ? errorId : undefined}
          className={textInput}
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="fiber-node-password-repeat" className="block text-sm text-muted-foreground">
          Repeat the password
        </label>
        <input
          id="fiber-node-password-repeat"
          type="password"
          autoComplete="new-password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          className={textInput}
        />
      </div>
      <button type="submit" disabled={nodeKey.busy || nodeKey.storageBlocked || !password} className={primaryButton}>
        {nodeKey.busy ? "Encrypting the key…" : "Create node"}
      </button>
    </form>
  );
}

export function UnlockKeyForm({ nodeKey, onKeys, errorId }: KeyFormProps) {
  const [password, setPassword] = useState("");
  useSecretReset(() => setPassword(""));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const keys = await nodeKey.unlock(password);
    setPassword("");
    if (keys) onKeys(keys);
  };
  const nodeId = nodeKey.record?.nodeId;
  return (
    <form onSubmit={submit} className="space-y-4" data-testid="fiber-node-unlock">
      <p className="text-muted-foreground leading-relaxed">
        {nodeId ? `Node ${shorten(nodeId, 8)} is stored in this browser.` : "A node key is stored in this browser."}
      </p>
      <div className="space-y-2">
        <label htmlFor="fiber-node-unlock-password" className="block text-sm text-muted-foreground">
          Password
        </label>
        <input
          id="fiber-node-unlock-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={!!nodeKey.error}
          aria-describedby={nodeKey.error ? errorId : undefined}
          className={textInput}
        />
      </div>
      <button type="submit" disabled={nodeKey.busy || !password} className={primaryButton}>
        {nodeKey.busy ? "Opening the key…" : "Unlock and start node"}
      </button>
    </form>
  );
}

export function RestoreKeyForm({ nodeKey, onKeys, replacing, errorId }: KeyFormProps & { replacing: boolean }) {
  const [backup, setBackup] = useState("");
  const [password, setPassword] = useState("");
  useSecretReset(() => setPassword(""));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const keys = await nodeKey.restore(backup, password);
    setPassword("");
    if (keys) {
      setBackup("");
      onKeys(keys);
    }
  };
  return (
    <details className="text-sm" data-testid="fiber-node-restore">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Restore from a backup</summary>
      <form onSubmit={submit} className="mt-4 space-y-4">
        {replacing && (
          <p className="text-xs text-muted-foreground leading-relaxed">Replaces the stored key. Back that one up first if it holds funds.</p>
        )}
        <div className="space-y-2">
          <label htmlFor="fiber-node-backup-text" className="block text-sm text-muted-foreground">
            Backup file contents
          </label>
          <textarea
            id="fiber-node-backup-text"
            value={backup}
            onChange={(e) => setBackup(e.target.value)}
            spellCheck={false}
            placeholder="Paste the backup's JSON…"
            className={textArea}
          />
          <input
            type="file"
            accept={BACKUP_FILE_TYPE}
            aria-label="Choose a backup file"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) setBackup(await file.text());
            }}
            className="block text-xs text-muted-foreground"
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="fiber-node-backup-password" className="block text-sm text-muted-foreground">
            The backup&apos;s password
          </label>
          <input
            id="fiber-node-backup-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!nodeKey.error}
            aria-describedby={nodeKey.error ? errorId : undefined}
            className={textInput}
          />
        </div>
        <button type="submit" disabled={nodeKey.busy || nodeKey.storageBlocked || !backup || !password} className={pillButton}>
          {nodeKey.busy ? "Opening the backup…" : "Restore and start node"}
        </button>
      </form>
    </details>
  );
}

/** A download link for the encrypted keystore: it opens only with the password. */
export function KeyBackup({ nodeKey }: { nodeKey: NodeKey }) {
  const record = nodeKey.record;
  const href = useMemo(
    () => (record ? URL.createObjectURL(new Blob([serializeKeystore(record)], { type: BACKUP_FILE_TYPE })) : null),
    [record],
  );
  useEffect(() => () => (href ? URL.revokeObjectURL(href) : undefined), [href]);
  if (!record || !href) return null;
  return (
    <div className={noteBox} data-testid="fiber-node-backup">
      <p className="text-sm font-medium">
        Back up the key{" "}
        <InfoTip label="About the backup" align="start">
          The file holds the node&apos;s keys, encrypted with your password. Anyone with the file and the password controls the node&apos;s
          funds, so keep both private. It restores the key only: open channels live in this browser&apos;s storage and cannot be restored
          from it, so close channels before you clear site data or switch browsers.
        </InfoTip>
      </p>
      <p className="text-xs text-muted-foreground leading-relaxed">Keep the file and password private. It does not restore channels.</p>
      <a href={href} download={backupFileName(record)} className={pillButton}>
        Download encrypted backup
      </a>
    </div>
  );
}

/** Two steps, because without a backup the node's funds are gone. */
export function ForgetKey({ nodeBusy, onForget }: { nodeBusy: boolean; onForget: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={nodeBusy}
        title={nodeBusy ? "Wait until the node has finished its swap requests." : undefined}
        className={textButton}
      >
        Forget this node
      </button>
    );
  }
  return (
    <div className={noteBox} role="alert" data-testid="fiber-node-forget">
      <p className="text-sm">Stops the node and deletes its key here. Without a backup, all its CKB is lost, channels included.</p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={async () => {
            await onForget();
            setConfirming(false);
          }}
          className={pillButton}
        >
          Yes, forget it
        </button>
        <button type="button" onClick={() => setConfirming(false)} className={textButton}>
          Keep the node
        </button>
      </div>
    </div>
  );
}
