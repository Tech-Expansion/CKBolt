"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { localeDecimalMark, parseAmountInput } from "@/lib/amount";
import { cccFundingTransport, type FundingTransport } from "@/lib/wallets/fiber-byo/ccc-funding";
import {
  CKB_FUNDING_TOKEN,
  checkFundingAmount,
  explorerTxUrl,
  formatFunding,
  FUNDING_PRESETS,
  FundingError,
  fundingErrorMessage,
  fundingUnits,
  parseFundingTarget,
  presetsFor,
  TESTNET_FUNDING_TOKENS,
  type CkbNetwork,
  type FundingPreset,
  type FundingToken,
  type FundingTransfer,
} from "@/lib/wallets/fiber-byo/funding";
import { useCkbWallet } from "./ckb-wallet";
import { InfoTip } from "./swap/info-tip";
import { CopyButton, onRadioGroupKeyDown, primaryButton, Row, secondaryButton, shorten, Tag } from "./ui";

/** A funding transfer the wallet sent. */
export interface FundingReceipt extends FundingTransfer {
  txHash: string;
}

export interface FundFiberNodeProps {
  /** The node address to fund, such as a browser node's own. Without it the visitor pastes one. */
  address?: string;
  /** Tokens offered besides CKB when the wallet holds some. Default: RUSD on CKB testnet. */
  tokens?: readonly FundingToken[];
  /** Suggested amounts. Default: FUNDING_PRESETS. */
  presets?: readonly FundingPreset[];
  /** Told once the wallet has sent the transfer. */
  onSent?: (receipt: FundingReceipt) => void;
}

type Step =
  | { kind: "edit" }
  | { kind: "confirm"; transfer: FundingTransfer }
  | { kind: "sending"; transfer: FundingTransfer }
  | { kind: "sent"; receipt: FundingReceipt };

/** Value of the amount radio group for a typed amount. */
const CUSTOM = "custom";

/** Which network the wallet's account is on, while it is read from the wallet, or when the wallet cannot say. */
type AccountNetwork = CkbNetwork | "checking" | "unreadable";

/** A failed transfer: the sentence, and the transaction's hash when it may still have gone out. */
interface FundingProblem {
  message: string;
  txHash?: string;
}

const problemOf = (e: unknown): FundingProblem => ({ message: fundingErrorMessage(e), txHash: e instanceof FundingError ? e.txHash : undefined });

/**
 * The network of the account the wallet holds, asked of the wallet itself: CCC may ask for testnet while a wallet stays
 * on mainnet, and then no CKB address of it can be read. Asked again whenever the account or `attempt` changes; a new
 * wallet starts from "checking", while the same wallet keeps its last answer until the new one comes, so the form does
 * not flicker. Sending checks the account again in any case.
 */
function useAccountNetwork(transport: FundingTransport | null, account: string, attempt: number): AccountNetwork {
  const [answer, setAnswer] = useState<{ transport: FundingTransport; network: AccountNetwork } | null>(null);
  useEffect(() => {
    if (!transport) return;
    let current = true;
    transport.accountNetwork().then(
      (network) => {
        if (current) setAnswer({ transport, network });
      },
      () => {
        if (current) setAnswer({ transport, network: "unreadable" });
      },
    );
    return () => {
      current = false;
    };
  }, [transport, account, attempt]);
  return answer !== null && answer.transport === transport ? answer.network : "checking";
}

const inputClass =
  "w-full h-11 border border-foreground/15 bg-background px-3 font-mono text-xs focus:outline-none focus:border-foreground focus-visible:ring-2 focus-visible:ring-foreground/25";
const chipClass =
  "min-h-10 px-3 py-2 border text-left text-sm aria-checked:bg-foreground aria-checked:text-background aria-checked:border-foreground border-foreground/15 hover:border-foreground/40 disabled:opacity-40 disabled:cursor-not-allowed";

/**
 * "Fund my Fiber node": sends test CKB (or RUSD, when the wallet holds some) from the connected CCC wallet to a Fiber
 * node's address, after a confirmation step, and shows the transaction. Refuses mainnet wallets and addresses.
 * Must sit inside CkbWalletProvider. Used by the bring-your-own-node guides and the browser node.
 */
export function FundFiberNode({ address, tokens = TESTNET_FUNDING_TOKENS, presets = FUNDING_PRESETS, onSent }: FundFiberNodeProps) {
  const w = useCkbWallet();
  const ids = useId();
  const decimalMark = useMemo(() => localeDecimalMark(), []);
  const transport = useMemo(() => (w.signer ? cccFundingTransport(w.signer) : null), [w.signer]);
  const [accountAttempt, setAccountAttempt] = useState(0);
  // The account as the wallet last read it, or why it could not: either changing means the wallet changed account.
  const accountNetwork = useAccountNetwork(transport, `${w.address ?? ""}|${w.error ?? ""}`, accountAttempt);
  const onTestnet = w.isTestnet && accountNetwork === "testnet";
  const onMainnet = !w.isTestnet || accountNetwork === "mainnet";

  const [addressText, setAddressText] = useState("");
  const [symbol, setSymbol] = useState(CKB_FUNDING_TOKEN.symbol);
  const [choice, setChoice] = useState<string | null>(null);
  const [customText, setCustomText] = useState("");
  const [tokenBalances, setTokenBalances] = useState<Record<string, bigint>>({});
  const [step, setStep] = useState<Step>({ kind: "edit" });
  const [error, setError] = useState<FundingProblem | null>(null);

  // A caller may pass a new array each render; the balances are read again only when the tokens really change.
  const tokensKey = tokens.map((t) => `${t.symbol}:${t.udt?.script.args ?? ""}`).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableTokens = useMemo(() => tokens, [tokensKey]);

  // What the wallet holds of each token decides whether that token is offered.
  useEffect(() => {
    setTokenBalances({});
    if (!transport || !onTestnet) return;
    let current = true;
    for (const token of stableTokens) {
      transport.readBalance(token).then(
        (balance) => {
          if (current) setTokenBalances((b) => ({ ...b, [token.symbol]: balance }));
        },
        // A token whose balance cannot be read is simply not offered.
        () => undefined,
      );
    }
    return () => {
      current = false;
    };
  }, [transport, onTestnet, stableTokens]);

  // Another wallet or account: start again, so nothing is sent from a wallet the visitor did not confirm.
  useEffect(() => {
    setStep({ kind: "edit" });
    setError(null);
  }, [w.signer, w.address]);

  const offered = [CKB_FUNDING_TOKEN, ...stableTokens.filter((t) => (tokenBalances[t.symbol] ?? BigInt(0)) > BigInt(0))];
  const token = offered.find((t) => t.symbol === symbol) ?? CKB_FUNDING_TOKEN;
  const tokenPresets = presetsFor(presets, token.symbol);
  const active = choice === CUSTOM || tokenPresets.some((p) => p.id === choice) ? (choice as string) : (tokenPresets[0]?.id ?? CUSTOM);
  const preset = tokenPresets.find((p) => p.id === active);
  const amount = preset ? preset.amount : parseAmountInput(customText, decimalMark);
  const units = fundingUnits(amount, token.decimals);
  const balance = token.udt ? tokenBalances[token.symbol] : w.balance;
  const amountError = checkFundingAmount(units, token, balance);
  const showAmountError = amountError !== null && (active !== CUSTOM || customText.trim() !== "");

  const target = parseFundingTarget(address ?? addressText, w.address);
  const ready = !!transport && onTestnet && target.status === "ok" && units !== null && amountError === null;
  const blockedReason =
    target.status === "empty"
      ? "Enter your node's address first."
      : target.status === "invalid"
        ? target.error
        : (amountError ?? undefined);

  const review = () => {
    if (!ready || target.status !== "ok" || units === null) return;
    setError(null);
    setStep({ kind: "confirm", transfer: { to: target.address, token, units } });
  };
  const send = async (transfer: FundingTransfer) => {
    if (!transport) return;
    setError(null);
    setStep({ kind: "sending", transfer });
    try {
      const txHash = await transport.send(transfer);
      const receipt = { ...transfer, txHash };
      setStep({ kind: "sent", receipt });
      onSent?.(receipt);
      void w.refresh();
    } catch (e) {
      setError(problemOf(e));
      setStep({ kind: "confirm", transfer });
    }
  };

  const addressId = `${ids}-address`;
  const addressNoteId = `${ids}-address-note`;
  const customId = `${ids}-amount`;
  const customNoteId = `${ids}-amount-note`;
  const editing = step.kind === "edit";

  return (
    <div className="border border-foreground/10 p-4 space-y-4" data-testid="fund-fiber-node">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">Fund my Fiber node</p>
        <Tag>CKB testnet</Tag>
      </div>
      <p className="text-sm text-muted-foreground leading-relaxed">
        From your CKB wallet to your node. Test money only.{" "}
        <InfoTip label="About funding" align="start">
          Your connected CKB wallet sends test CKB to your Fiber node&apos;s address; the node then opens channels with it. CKBolt refuses
          mainnet wallets and addresses.
        </InfoTip>
      </p>

      {!w.signer ? (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={w.open} className={secondaryButton}>
            Connect CKB wallet
          </button>
          <p className="text-xs text-muted-foreground">JoyID, MetaMask, UTXO Global and more through CCC.</p>
        </div>
      ) : onMainnet ? (
        <p className="text-sm text-destructive" role="status" data-testid="fund-wrong-network">
          Your CKB wallet is on CKB mainnet. Switch it to CKB testnet: CKBolt only sends test CKB.
        </p>
      ) : accountNetwork === "unreadable" ? (
        <div className="flex flex-wrap items-center gap-3" data-testid="fund-account-unreadable">
          <p className="text-sm text-destructive" role="status">
            Your CKB wallet did not say which account it holds. Unlock it or reconnect it, then check again.
          </p>
          <button type="button" onClick={() => setAccountAttempt((n) => n + 1)} className={secondaryButton}>
            Check again
          </button>
        </div>
      ) : !onTestnet ? (
        <p className="text-sm text-muted-foreground" role="status" data-testid="fund-account-checking">
          Checking which network your CKB wallet is on…
        </p>
      ) : (
        <>
          {editing && (
            <div className="space-y-4">
              {address === undefined ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-1">
                    <label htmlFor={addressId} className="block text-sm text-muted-foreground">
                      Your Fiber node&apos;s CKB address
                    </label>
                    <InfoTip label="Where to find the address" align="start">
                      Fiber Studio shows the node&apos;s funding address. With fnn, paste node_info&apos;s default_funding_lock_script or its
                      ckt1… address.
                    </InfoTip>
                  </div>
                  <input
                    id={addressId}
                    value={addressText}
                    onChange={(e) => setAddressText(e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="ckt1…"
                    aria-invalid={target.status === "invalid"}
                    aria-describedby={addressNoteId}
                    className={inputClass}
                  />
                  <p id={addressNoteId} className={`text-xs ${target.status === "invalid" ? "text-destructive" : "text-muted-foreground"}`}>
                    {target.status === "invalid"
                      ? target.error
                      : "Its ckt1… address, or fnn's funding lock script."}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <dl>
                    <Row label="To your node" value={shorten(address, 12)} />
                  </dl>
                  {target.status === "invalid" && <p className="text-xs text-destructive">{target.error}</p>}
                </div>
              )}

              {offered.length > 1 && (
                <div role="radiogroup" aria-label="Token to send" onKeyDown={onRadioGroupKeyDown} className="flex flex-wrap gap-2">
                  {offered.map((t) => (
                    <button
                      key={t.symbol}
                      type="button"
                      role="radio"
                      aria-checked={t.symbol === token.symbol}
                      tabIndex={t.symbol === token.symbol ? 0 : -1}
                      onClick={() => {
                        // An amount typed for one token means nothing for another: start from its first preset.
                        if (t.symbol !== token.symbol) {
                          setChoice(null);
                          setCustomText("");
                        }
                        setSymbol(t.symbol);
                      }}
                      className={chipClass}
                    >
                      {t.symbol}
                    </button>
                  ))}
                </div>
              )}

              <div className="space-y-2">
                <p id={`${ids}-amounts`} className="text-sm text-muted-foreground">
                  Amount
                </p>
                <div role="radiogroup" aria-labelledby={`${ids}-amounts`} onKeyDown={onRadioGroupKeyDown} className="grid gap-2" data-testid="fund-presets">
                  {tokenPresets.map((p) => {
                    const amountText = `${p.amount.toLocaleString("en-US")} ${p.symbol}`;
                    const detailId = `${ids}-${p.id}-detail`;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="radio"
                        aria-checked={active === p.id}
                        aria-label={`${amountText}: ${p.label}`}
                        aria-describedby={detailId}
                        tabIndex={active === p.id ? 0 : -1}
                        onClick={() => setChoice(p.id)}
                        className={`group ${chipClass}`}
                      >
                        <span className="font-mono">{amountText}</span>
                        <span className="ml-2">{p.label}</span>
                        <span id={detailId} className="block text-xs text-muted-foreground group-aria-checked:text-background/70">
                          {p.detail}
                        </span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={active === CUSTOM}
                    tabIndex={active === CUSTOM ? 0 : -1}
                    onClick={() => setChoice(CUSTOM)}
                    className={chipClass}
                  >
                    Another amount
                  </button>
                </div>
                {active === CUSTOM && (
                  <div className="space-y-1">
                    <label htmlFor={customId} className="block text-xs text-muted-foreground">
                      Amount in {token.symbol}
                    </label>
                    <input
                      id={customId}
                      value={customText}
                      onChange={(e) => setCustomText(e.target.value)}
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="0"
                      aria-invalid={showAmountError}
                      aria-describedby={customNoteId}
                      className={inputClass}
                    />
                  </div>
                )}
                <p id={customNoteId} className={`text-xs ${showAmountError ? "text-destructive" : "text-muted-foreground"}`}>
                  {showAmountError
                    ? amountError
                    : `From ${w.wallet?.name ?? "your wallet"}, which holds ${balance === undefined ? "…" : formatFunding(balance, token)}.${
                        token.udt ? ` The ${token.symbol} cell also brings some CKB to the node.` : ""
                      }`}
                </p>
              </div>

              <button type="button" onClick={review} disabled={!ready} title={ready ? undefined : blockedReason} className={primaryButton}>
                Review transfer
              </button>
            </div>
          )}

          {(step.kind === "confirm" || step.kind === "sending") && (
            <div className="space-y-4" data-testid="fund-confirm">
              <p className="text-sm font-medium">Check, then send from your wallet</p>
              <dl>
                <Row label="From" value={w.address ? shorten(w.address, 10) : "Your wallet"} note={w.wallet?.name} />
                <Row label="To" value={step.transfer.to} note="Your Fiber node: check the whole address" />
                <Row label="Amount" value={formatFunding(step.transfer.units, step.transfer.token)} />
                <Row label="Network" value="CKB testnet" note="Test money only" />
                <Row label="Network fee" value="Added by your wallet" note="A small CKB testnet fee" />
              </dl>
              <p className="text-xs text-muted-foreground">Your wallet asks you to sign. Once sent, a transfer cannot be undone.</p>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void send(step.transfer)}
                  disabled={step.kind === "sending"}
                  className={primaryButton}
                >
                  {step.kind === "sending" ? "Waiting for your wallet…" : `Send ${formatFunding(step.transfer.units, step.transfer.token)}`}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setStep({ kind: "edit" });
                  }}
                  disabled={step.kind === "sending"}
                  className={secondaryButton}
                >
                  Back
                </button>
              </div>
            </div>
          )}

          {step.kind === "sent" && (
            <div className="space-y-3" data-testid="fund-sent">
              <p className="text-sm" role="status">
                Sent {formatFunding(step.receipt.units, step.receipt.token)} to your node. It can use it once the transaction confirms on
                CKB testnet.
              </p>
              <dl>
                <Row label="Transaction" value={shorten(step.receipt.txHash, 10)} />
              </dl>
              <div className="flex flex-wrap items-center gap-4">
                <a
                  href={explorerTxUrl(step.receipt.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm underline underline-offset-4 hover:text-foreground"
                  data-testid="fund-explorer"
                >
                  View on CKB Explorer (testnet)
                </a>
                <CopyButton value={step.receipt.txHash} label="Copy transaction hash" />
              </div>
              <button type="button" onClick={() => setStep({ kind: "edit" })} className={secondaryButton}>
                Send more
              </button>
            </div>
          )}

          {error && (
            <div className="space-y-2">
              <p className="text-sm text-destructive" role="alert" data-testid="fund-error">
                {error.message}
              </p>
              {error.txHash && (
                <a
                  href={explorerTxUrl(error.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm underline underline-offset-4 hover:text-foreground"
                  data-testid="fund-error-explorer"
                >
                  Look it up on CKB Explorer (testnet)
                </a>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
