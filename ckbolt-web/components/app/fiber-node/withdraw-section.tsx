"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { FiberAssetId, Script } from "@/lib/hub/contract";
import { formatUnits } from "@/lib/hub/format";
import { WITHDRAW_STATUS_SENT, type ActivityEntry } from "@/lib/wallets/fiber-browser/activity";
import { CKB_ASSET, channelsMovingFunds } from "@/lib/wallets/fiber-browser/channels";
import type { CkbAddressNetwork } from "@/lib/wallets/fiber-browser/ckb-address";
import { browserKeystoreDeps, decryptKeys, WrongPasswordError, type KeystoreRecord } from "@/lib/wallets/fiber-browser/keystore";
import { wipeKeys, type NodeKeys } from "@/lib/wallets/fiber-browser/keys";
import type { BrowserFiberNode, NodeChannel } from "@/lib/wallets/fiber-browser/node-port";
import {
  parseCkbDestination,
  withdrawBlock,
  withdrawErrors,
  WithdrawError,
  type WithdrawReceipt,
} from "@/lib/wallets/fiber-browser/withdraw";
import { CKB_ADDRESS_PREFIX, CKB_DECIMALS } from "@/lib/wallets/fiber-browser/constants";
import type { WithdrawableToken } from "@/lib/wallets/fiber-browser/token-withdraw";
import { explorerTxUrl } from "@/lib/wallets/fiber-byo/funding";
import { InfoTip } from "../swap/info-tip";
import { CopyButton, primaryButton, Row, shorten } from "../ui";
import { WITHDRAW_COPY } from "./copy";
import { DestinationField } from "./destination-field";
import { ChoiceGroup } from "./fields";
import { StatusNotice } from "../status";
import { useSecretReset } from "./secret-reset";
import { noteBox, pillButton, textButton, textInput } from "./styles";

interface WithdrawSectionProps {
  /** The stored, encrypted node keys: the password opens them again to sign. */
  record: KeystoreRecord | null;
  rpcUrl: string;
  network: CkbAddressNetwork;
  /** The running node, to read its channels once more right before signing. */
  node: BrowserFiberNode | null;
  nodeLock: Script;
  /** Shannons in plain cells at the node's address, or null until read. */
  balance: bigint | null;
  channels: NodeChannel[];
  /** Told once the withdrawal went out, so the page reads the balance again. */
  onSent: () => void;
  /** Adds the withdrawal to the node's history. */
  onRecord?: (entry: ActivityEntry) => void;
  /** Shows the form at once (the wallet's Withdraw tab) instead of the Withdraw button first. */
  startOpen?: boolean;
  /** The hub's tokens the node may hold on chain; those it holds become choices besides CKB. */
  tokens?: readonly WithdrawableToken[];
  /** Reads the node's on-chain amount of a token (base units); null while the node's address is unknown. */
  readTokenBalance?: ((script: Script) => Promise<bigint>) | null;
}

type Phase = "preparing" | "opening" | "sending";

interface Sent extends WithdrawReceipt {
  address: string;
  /** A token's symbol and decimals; absent for CKB. */
  token?: { symbol: string; decimals: number };
}

/** The node's on-chain amount of each token, read once when the form opens; a token that could not be read is left out. */
function useTokenBalances(tokens: readonly WithdrawableToken[], read: ((script: Script) => Promise<bigint>) | null): Partial<Record<FiberAssetId, bigint>> {
  const [balances, setBalances] = useState<Partial<Record<FiberAssetId, bigint>>>({});
  useEffect(() => {
    if (!read) return;
    let alive = true;
    for (const t of tokens) {
      read(t.token.script).then(
        (amount) => alive && setBalances((b) => ({ ...b, [t.id]: amount })),
        () => undefined,
      );
    }
    return () => {
      alive = false;
    };
  }, [tokens, read]);
  return balances;
}

interface Problem {
  message: string;
  txHash?: string;
  /** The password did not open the key. */
  password: boolean;
}

const ckb = (shannons: bigint): string => formatUnits(shannons.toString(), CKB_DECIMALS);

const PHASE_LABEL: Record<Phase, string> = {
  preparing: WITHDRAW_COPY.PREPARING,
  opening: WITHDRAW_COPY.OPENING_KEY,
  sending: WITHDRAW_COPY.SENDING,
};

const ADDRESS_ID = "fiber-node-withdraw-address";
const NO_TOKENS: readonly WithdrawableToken[] = [];
const PASSWORD_ID = "fiber-node-withdraw-password";
const ERROR_ID = "fiber-node-withdraw-error";

/**
 * "Withdraw" on the node panel: all the node's on-chain CKB to the visitor's address, in one transaction the page signs
 * with the node's CKB key. The page holds no key while the node runs (fiber-js has its own copy), so the visitor's
 * password opens the stored keystore again; the keys are wiped once signed. Refused while a channel opens or closes.
 */
export function WithdrawSection({ startOpen = false, ...props }: WithdrawSectionProps) {
  const [open, setOpen] = useState(startOpen);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={pillButton} data-testid="fiber-node-withdraw-open">
        {WITHDRAW_COPY.OPEN}
      </button>
    );
  }
  return <WithdrawForm {...props} onCancel={() => setOpen(false)} />;
}

function WithdrawForm({
  record,
  rpcUrl,
  network,
  node,
  nodeLock,
  balance,
  channels,
  onSent,
  onRecord,
  onCancel,
  tokens = NO_TOKENS,
  readTokenBalance = null,
}: WithdrawSectionProps & { onCancel: () => void }) {
  const [text, setText] = useState("");
  const [asset, setAsset] = useState<FiberAssetId>(CKB_ASSET);
  const tokenBalances = useTokenBalances(tokens, readTokenBalance);
  const held = tokens.filter((t) => (tokenBalances[t.id] ?? BigInt(0)) > BigInt(0));
  const chosen = held.find((t) => t.id === asset) ?? null;
  const chosenBalance = chosen ? (tokenBalances[chosen.id] ?? BigInt(0)) : null;
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<Phase | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const destination = parseCkbDestination(text, network, nodeLock);
  const blocked = chosen ? (channelsMovingFunds(channels).length > 0 ? withdrawErrors.channelsMoving().message : null) : withdrawBlock(balance, channels);
  useSecretReset(() => setPassword(""));

  if (sent) return <WithdrawSent sent={sent} onDone={onCancel} />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (blocked || destination.status !== "ok" || !record || !node || !password) return;
    setProblem(null);
    let keys: NodeKeys | null = null;
    try {
      setPhase("preparing");
      // CCC loads only now, before the key is opened, so the key is in memory for as short a time as possible.
      const { cccNodeClient, withdrawAll, withdrawTokenAll } = await import("@/lib/wallets/fiber-browser/ccc-withdraw");
      // A channel may have started opening since the last read: fnn could be spending these cells.
      if (channelsMovingFunds(await node.listChannels()).length > 0) throw withdrawErrors.channelsMoving();
      setPhase("opening");
      keys = await decryptKeys(record, password, browserKeystoreDeps());
      setPhase("sending");
      const request = { client: cccNodeClient(rpcUrl, network), keys, nodeLock, to: destination.script };
      const receipt = chosen ? await withdrawTokenAll({ ...request, token: chosen.token }) : await withdrawAll(request);
      setPassword("");
      setSent({ ...receipt, address: destination.address, ...(chosen ? { token: { symbol: chosen.symbol, decimals: chosen.decimals } } : {}) });
      onRecord?.({
        id: receipt.txHash,
        kind: "withdraw",
        asset: chosen?.id ?? CKB_ASSET,
        amount: receipt.amount.toString(),
        status: WITHDRAW_STATUS_SENT,
        error: null,
        at: Date.now(),
        // A withdrawal's fee is in CKB: kept only where the asset is CKB too.
        fee: chosen ? null : receipt.fee.toString(),
        txHash: receipt.txHash,
        address: destination.address,
      });
      onSent();
    } catch (err) {
      // The password is typed again for the next try: it never stays in the form.
      setPassword("");
      setProblem({
        message: err instanceof Error && err.message ? err.message : WITHDRAW_COPY.TITLE,
        txHash: err instanceof WithdrawError ? err.txHash : undefined,
        password: err instanceof WrongPasswordError,
      });
    } finally {
      if (keys) wipeKeys(keys);
      setPhase(null);
    }
  };

  const busy = phase !== null;
  const amount = chosen && chosenBalance !== null ? formatUnits(chosenBalance.toString(), chosen.decimals) : balance === null ? null : ckb(balance);
  const canSubmit = !blocked && destination.status === "ok" && !!password && !busy && !!node && !!record;
  // A disabled button says why (style guide: Accessibility conventions).
  const whyDisabled = blocked ?? (destination.status !== "ok" ? WITHDRAW_COPY.NEEDS_ADDRESS : !password ? WITHDRAW_COPY.NEEDS_PASSWORD : null);
  return (
    <form onSubmit={submit} className={noteBox} data-testid="fiber-node-withdraw" noValidate>
      <p className="flex items-center gap-1 text-sm font-medium">
        {chosen ? WITHDRAW_COPY.TITLE_TOKEN(chosen.symbol) : WITHDRAW_COPY.TITLE}
        <InfoTip label={WITHDRAW_COPY.TIP_LABEL} align="start">
          {WITHDRAW_COPY.TIP}
        </InfoTip>
      </p>
      {held.length > 0 && (
        <div data-testid="fiber-node-withdraw-asset">
          <ChoiceGroup
            label={WITHDRAW_COPY.ASSET_LABEL}
            options={[{ value: CKB_ASSET, label: CKB_ASSET }, ...held.map((t) => ({ value: t.id, label: t.symbol }))]}
            value={chosen?.id ?? CKB_ASSET}
            onChange={setAsset}
            disabled={busy}
          />
        </div>
      )}
      {amount !== null && (
        <p className="text-sm" data-testid="fiber-node-withdraw-amount">
          {chosen ? WITHDRAW_COPY.TOKEN_AMOUNT(amount, chosen.symbol) : WITHDRAW_COPY.AMOUNT(amount)}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{chosen ? WITHDRAW_COPY.TOKEN_CHANNELS_NOTE : WITHDRAW_COPY.CHANNELS_NOTE}</p>
      <DestinationField
        id={ADDRESS_ID}
        label={WITHDRAW_COPY.ADDRESS_LABEL}
        prefix={CKB_ADDRESS_PREFIX[network]}
        value={text}
        onChange={setText}
        destination={destination}
      />
      <div className="space-y-2">
        <label htmlFor={PASSWORD_ID} className="block text-sm text-muted-foreground">
          {WITHDRAW_COPY.PASSWORD_LABEL}
        </label>
        <input
          id={PASSWORD_ID}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={!!problem?.password}
          aria-describedby={problem?.password ? ERROR_ID : undefined}
          className={textInput}
        />
      </div>
      <div aria-live="polite">
        {blocked && (
          <StatusNotice tone="pending" role="status" data-testid="fiber-node-withdraw-blocked">
            {blocked}
          </StatusNotice>
        )}
        {problem && (
          <StatusNotice tone="error" role="alert">
            <p id={ERROR_ID} data-testid="fiber-node-withdraw-error">
              {problem.message}
            </p>
            {problem.txHash && (
              <a href={explorerTxUrl(problem.txHash)} target="_blank" rel="noopener noreferrer" className="text-sm underline underline-offset-4">
                {WITHDRAW_COPY.LOOK_UP}
              </a>
            )}
          </StatusNotice>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={!canSubmit}
          title={whyDisabled ?? undefined}
          className={primaryButton}
        >
          {phase ? PHASE_LABEL[phase] : chosen ? WITHDRAW_COPY.SUBMIT_TOKEN(amount ?? "…", chosen.symbol) : WITHDRAW_COPY.SUBMIT(amount ?? "…")}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={textButton}>
          {WITHDRAW_COPY.CANCEL}
        </button>
      </div>
    </form>
  );
}

/** The withdrawal that went out: what, where, the fee, and the transaction with its explorer link. */
function WithdrawSent({ sent, onDone }: { sent: Sent; onDone: () => void }) {
  return (
    <div className={noteBox} data-testid="fiber-node-withdraw-sent">
      <StatusNotice tone="ok" role="status">
        {sent.token
          ? WITHDRAW_COPY.SENT_TOKEN(`${formatUnits(sent.amount.toString(), sent.token.decimals)} ${sent.token.symbol}`, shorten(sent.address, 12))
          : WITHDRAW_COPY.SENT(ckb(sent.amount), shorten(sent.address, 12))}
      </StatusNotice>
      <dl>
        <Row label={WITHDRAW_COPY.FEE} value={`${ckb(sent.fee)} CKB`} />
        <Row label={WITHDRAW_COPY.TRANSACTION} value={shorten(sent.txHash, 10)} />
      </dl>
      <div className="flex flex-wrap items-center gap-x-5">
        <CopyButton value={sent.txHash} label={WITHDRAW_COPY.COPY_HASH} />
        <a
          href={explorerTxUrl(sent.txHash)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-10 items-center text-sm underline underline-offset-4"
        >
          {WITHDRAW_COPY.EXPLORER}
        </a>
      </div>
      <button type="button" onClick={onDone} className={textButton}>
        {WITHDRAW_COPY.DONE}
      </button>
    </div>
  );
}
