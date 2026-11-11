"use client";

import type { ReactNode } from "react";
import { FAUCET_LINK_LABEL, type TokenFaucet } from "@/lib/faucets";
import { fundNodeHref, urlHost } from "@/lib/wallets/fiber-browser/links";
import { CKB_TESTNET_FAUCET_URL } from "@/lib/wallets/fiber-browser/constants";
import { QrCode } from "../qr-code";
import { InfoTip } from "../swap/info-tip";
import { CopyButton } from "../ui";
import { NODE_ADDRESS_COPY } from "./copy";
import { pillButton, textButton } from "./styles";

interface NodeAddressProps {
  address: string;
  onRefreshBalance: () => void;
  /** The funding link's label: "Fund this node" on the node page, "Fund from a wallet" in the wallet. */
  fundLabel?: string;
  /** Shows the address as a QR code too, for a phone wallet. */
  qr?: boolean;
  /** Faucets of the tokens the hub serves (cWBTC): "Get test cWBTC" under the CKB faucet. */
  faucets?: readonly TokenFaucet[];
  /** What follows the funding controls (the node page's Withdraw). */
  children?: ReactNode;
}

/**
 * The node's CKB testnet address with Copy, and the ways to fund it: the funding page in a new tab (not isolated, so
 * CCC wallet popups such as JoyID work there) or the faucet, and the faucets of the tokens the hub serves (claimed to
 * the same address). Shared by the node page and the wallet's Add funds page.
 */
export function NodeAddress({ address, onRefreshBalance, fundLabel = NODE_ADDRESS_COPY.FUND, qr = false, faucets = [], children }: NodeAddressProps) {
  return (
    <div className="space-y-3" data-testid="fiber-node-address">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{NODE_ADDRESS_COPY.TITLE}</p>
        <CopyButton value={address} label={NODE_ADDRESS_COPY.COPY} />
      </div>
      {qr && <QrCode text={address} alt={NODE_ADDRESS_COPY.QR_ALT} testId="fiber-node-address-qr" />}
      <p className="font-mono text-xs text-muted-foreground break-all">{address}</p>
      <div className="flex flex-wrap items-center gap-3">
        <a href={fundNodeHref(address)} target="_blank" rel="noopener" className={pillButton} data-testid="fiber-node-fund">
          {fundLabel}
        </a>
        <button type="button" onClick={onRefreshBalance} className={textButton}>
          {NODE_ADDRESS_COPY.REFRESH}
        </button>
        <InfoTip label={NODE_ADDRESS_COPY.FUND_TIP_LABEL}>{NODE_ADDRESS_COPY.FUND_TIP(fundLabel)}</InfoTip>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        {NODE_ADDRESS_COPY.FAUCET}{" "}
        <a href={CKB_TESTNET_FAUCET_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
          {urlHost(CKB_TESTNET_FAUCET_URL)}
        </a>
        .
      </p>
      {faucets.map((faucet) => (
        <p key={faucet.id} className="text-xs text-muted-foreground leading-relaxed">
          <a
            href={faucet.href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
            data-testid={`fiber-node-faucet-${faucet.id}`}
          >
            {FAUCET_LINK_LABEL(faucet.symbol)}
          </a>{" "}
          {NODE_ADDRESS_COPY.TOKEN_FAUCET(urlHost(faucet.href))}
        </p>
      ))}
      {children}
    </div>
  );
}
