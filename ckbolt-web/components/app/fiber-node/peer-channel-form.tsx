"use client";

import { useState, type FormEvent } from "react";
import { localeDecimalMark } from "@/lib/amount";
import type { FiberAssetId } from "@/lib/hub/contract";
import { formatUnits } from "@/lib/hub/format";
import { needsTlsPeers } from "@/lib/wallets/fiber-browser/node-config";
import { formatTokenAmount } from "@/lib/wallets/fiber-browser/tokens";
import { checkPeerChannel } from "@/lib/wallets/fiber-browser/peer-channel";
import { CKB_DECIMALS } from "@/lib/wallets/fiber-browser/constants";
import { Disclosure } from "../swap/disclosure";
import { InfoTip } from "../swap/info-tip";
import { pillButton } from "./styles";
import { ActionNotice } from "./action-notice";
import { CHANNEL_ACTION, openPeerChannel, recorded } from "./channel-actions";
import { PEER_CHANNEL_COPY } from "./copy";
import { TextField, TokenPicker } from "./fields";
import type { NodeAction } from "./use-node-action";
import type { NodeWorkspace } from "./use-node-workspace";
import { useTokenBalance } from "./use-token-balance";

/**
 * "Open with another node" (or `label`: the popup's "Advanced"), collapsed until asked for: the node dials another
 * node's WebSocket address and opens and funds a channel with it in CKB or a token. The CKBolt hub takes payments only
 * over channels it opened itself, so the "?" says swaps never use this channel, and the hub's own id is refused here.
 */
export function PeerChannelForm({
  ws,
  action,
  noticeTestId,
  label = PEER_CHANNEL_COPY.TITLE,
}: {
  ws: NodeWorkspace;
  action: NodeAction;
  noticeTestId: string;
  label?: string;
}) {
  const { node, tokens } = ws;
  const [nodeId, setNodeId] = useState("");
  const [address, setAddress] = useState("");
  const [tokenId, setTokenId] = useState<FiberAssetId>(tokens[0]?.id ?? "CKB");
  const [amount, setAmount] = useState("");
  const token = tokens.find((t) => t.id === tokenId) ?? tokens[0];
  const tokenBalance = useTokenBalance(ws.rpc, ws.fundingLock, token);
  const check = checkPeerChannel({
    nodeId,
    address,
    amount,
    token,
    ownNodeId: ws.state.info?.nodeId ?? null,
    hubNodeIds: ws.hubNodeIds,
    balance: ws.data.balance,
    tokenBalance,
    secureOnly: typeof location !== "undefined" && needsTlsPeers(location),
    decimalMark: localeDecimalMark(),
  });
  const errorOf = (field: "nodeId" | "address" | "amount", text: string) => (text.trim() && !check.ok && check.field === field ? check.error : null);
  const working = action.working !== null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!check.ok || working) return;
    const plan = check.value;
    void action.run(CHANNEL_ACTION.PEER, () =>
      recorded(ws.activity.record)(openPeerChannel(node, plan, { channels: ws.data.channels, assetOf: ws.assetOf })),
    );
  };

  return (
    <Disclosure
      label={label}
      testId="fiber-wallet-peer-channel"
      toggleClassName="text-sm"
    >
      <form onSubmit={submit} className="mt-3 space-y-4" noValidate>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          {PEER_CHANNEL_COPY.LEAD}
          <InfoTip label={PEER_CHANNEL_COPY.TIP_LABEL} align="start">
            {PEER_CHANNEL_COPY.TIP}
          </InfoTip>
        </p>
        <TextField
          label={PEER_CHANNEL_COPY.NODE_ID}
          value={nodeId}
          onChange={setNodeId}
          placeholder={PEER_CHANNEL_COPY.NODE_ID_PLACEHOLDER}
          error={errorOf("nodeId", nodeId)}
          testId="fiber-wallet-peer-node-id"
        />
        <TextField
          label={PEER_CHANNEL_COPY.ADDRESS}
          value={address}
          onChange={setAddress}
          placeholder={PEER_CHANNEL_COPY.ADDRESS_PLACEHOLDER}
          error={errorOf("address", address)}
          tip={
            <InfoTip label={PEER_CHANNEL_COPY.ADDRESS_TIP_LABEL} align="start">
              {PEER_CHANNEL_COPY.ADDRESS_TIP}
            </InfoTip>
          }
          testId="fiber-wallet-peer-address"
        />
        <TokenPicker label={PEER_CHANNEL_COPY.TOKEN} tokens={tokens} value={token.id} onChange={setTokenId} />
        <TextField
          label={PEER_CHANNEL_COPY.AMOUNT}
          value={amount}
          onChange={setAmount}
          inputMode="decimal"
          hint={
            tokenBalance !== null
              ? PEER_CHANNEL_COPY.HOLDS_TOKEN(formatTokenAmount(tokenBalance, token))
              : ws.data.balance === null
                ? undefined
                : PEER_CHANNEL_COPY.HOLDS(formatUnits(ws.data.balance.toString(), CKB_DECIMALS))
          }
          error={errorOf("amount", amount)}
          testId="fiber-wallet-peer-amount"
        />
        <button type="submit" disabled={!check.ok || working || !node} title={check.ok ? undefined : check.error} className={pillButton}>
          {action.working === CHANNEL_ACTION.PEER ? PEER_CHANNEL_COPY.OPENING_NOW : PEER_CHANNEL_COPY.SUBMIT}
        </button>
        <ActionNotice action={action} testId={noticeTestId} of={CHANNEL_ACTION.isPeer} />
      </form>
    </Disclosure>
  );
}
