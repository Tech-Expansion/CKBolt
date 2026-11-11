"use client";

import { useEffect } from "react";
import type { CkbDestination } from "@/lib/wallets/fiber-browser/withdraw";
import { InfoTip } from "../swap/info-tip";
import { DESTINATION_COPY } from "./copy";
import { textButton, textInput } from "./styles";
import { useWalletPicker } from "./wallet-picker";

interface DestinationFieldProps {
  id: string;
  label: string;
  /** The address prefix of the node's network ("ckt"), for the placeholder. */
  prefix: string;
  value: string;
  onChange: (text: string) => void;
  /** The text as parsed (parseCkbDestination): its error shows under the field. */
  destination: CkbDestination;
}

/**
 * A CKB address for the node's CKB: pasted, or taken from the visitor's CKB wallet (CCC) with one button. The address is
 * checked by the caller: on the node's network, and not the node's own.
 */
export function DestinationField({ id, label, prefix, value, onChange, destination }: DestinationFieldProps) {
  const picker = useWalletPicker();
  const { load } = picker;
  // The connector loads as soon as the field shows, so a wallet connected earlier is ready to use.
  useEffect(() => load(), [load]);
  const errorId = `${id}-error`;
  const invalid = destination.status === "invalid";
  const walletLabel = !picker.ready
    ? DESTINATION_COPY.LOADING_WALLETS
    : picker.walletName
      ? DESTINATION_COPY.USE_WALLET(picker.walletName)
      : DESTINATION_COPY.CONNECT_WALLET;
  return (
    <div className="space-y-2" data-testid={`${id}-field`}>
      <label htmlFor={id} className="block text-sm text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        placeholder={DESTINATION_COPY.PLACEHOLDER(prefix)}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        className={textInput}
      />
      {invalid && (
        <p id={errorId} className="text-sm text-destructive">
          {destination.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3">
        <button type="button" onClick={() => picker.pick(onChange)} disabled={!picker.ready} className={textButton}>
          {walletLabel}
        </button>
        <InfoTip label={DESTINATION_COPY.WALLET_TIP_LABEL} align="start">
          {DESTINATION_COPY.WALLET_TIP}
        </InfoTip>
      </div>
      {picker.error && <p className="text-sm text-destructive">{picker.error}</p>}
    </div>
  );
}
