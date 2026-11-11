"use client";

import { useId, useState } from "react";
import type { Script } from "@/lib/hub/contract";
import { formatUnits } from "@/lib/hub/format";
import { channelStateTone } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import { channelAsset, channelStateLabel, isChannelReady, type HubAssets } from "@/lib/wallets/fiber-browser/channels";
import type { CkbAddressNetwork } from "@/lib/wallets/fiber-browser/ckb-address";
import type { NodeChannel } from "@/lib/wallets/fiber-browser/node-port";
import { parseCkbDestination } from "@/lib/wallets/fiber-browser/withdraw";
import { CKB_ADDRESS_PREFIX } from "@/lib/wallets/fiber-browser/constants";
import { StatusBadge, statusRule } from "../status";
import { InfoTip } from "../swap/info-tip";
import { onRadioGroupKeyDown, shorten } from "../ui";
import { CHANNEL_LIST_COPY, CLOSE_COPY } from "./copy";
import { DestinationField } from "./destination-field";
import { choiceChip, noteBox, pillButton, textButton } from "./styles";

/** Where a closing channel's share goes: the node's own lock (null), or the visitor's address. */
export interface CloseTarget {
  script: Script;
  address: string;
}

interface ChannelListProps {
  channels: NodeChannel[];
  hubNodeId: string | null;
  assets: HubAssets;
  decimalsOf: (asset: string) => number;
  /** An asset's symbol as the hub lists it ("cWBTC" for the id CWBTC); the id itself without it. */
  symbolOf?: (asset: string) => string;
  /** The node's CKB network: a wallet address for a close must be on it. */
  network: CkbAddressNetwork;
  /** The node's own lock, refused as a "wallet" address. */
  nodeLock: Script | null;
  onClose: (channel: NodeChannel, target: CloseTarget | null) => Promise<void>;
  /** A table on the node page; stacked cards in the narrow wallet popup. */
  layout?: "table" | "cards";
}

const UNKNOWN_ASSET = "Token";

/**
 * The node's channels with what each can send and receive; ready ones can be closed cooperatively, after a confirmation
 * that says where the node's share goes: back to the node's address, or straight to the visitor's wallet.
 */
export function ChannelList({ channels, hubNodeId, assets, decimalsOf, symbolOf, network, nodeLock, onClose, layout = "table" }: ChannelListProps) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const confirmId = useId();
  if (channels.length === 0) {
    return <p className="text-sm text-muted-foreground">{CHANNEL_LIST_COPY.EMPTY}</p>;
  }
  const peerName = (c: NodeChannel) => (c.peerId === hubNodeId ? CLOSE_COPY.HUB_PEER : shorten(c.peerId, 6));
  const idOf = (c: NodeChannel) => channelAsset(c, assets);
  // What the visitor reads: the hub's symbol (cWBTC), or "Token" for one the hub does not list.
  const assetOf = (c: NodeChannel) => {
    const id = idOf(c);
    return id === null ? UNKNOWN_ASSET : (symbolOf?.(id) ?? id);
  };
  // Only a channel still ready can be closed; one that changed state meanwhile drops its confirmation.
  const closing = channels.find((c) => c.channelId === confirming && isChannelReady(c)) ?? null;
  const closeButton = (c: NodeChannel) => {
    const open = closing?.channelId === c.channelId;
    return (
      isChannelReady(c) && (
        <button
          type="button"
          onClick={() => setConfirming(open ? null : c.channelId)}
          aria-label={CLOSE_COPY.CLOSE_LABEL(assetOf(c), peerName(c))}
          aria-expanded={open}
          aria-controls={open ? confirmId : undefined}
          className={textButton}
        >
          {CLOSE_COPY.CLOSE}
        </button>
      )
    );
  };
  const units = (c: NodeChannel, amount: bigint) => formatUnits(amount.toString(), decimalsOf(idOf(c) ?? UNKNOWN_ASSET));
  return (
    <div className="space-y-4">
      {layout === "cards" ? (
        <ul className="border border-foreground/10" aria-label={CHANNEL_LIST_COPY.LABEL} data-testid="fiber-node-channels">
          {channels.map((c) => (
            <li key={c.channelId} className={cn("px-3 py-2 border-b border-foreground/5 last:border-b-0", statusRule(channelStateTone(c.state)))}>
              {/* The title keeps one line; a long state badge wraps under it instead. */}
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="whitespace-nowrap text-sm">
                  {c.peerId === hubNodeId ? CHANNEL_LIST_COPY.HUB : <span className="font-mono text-xs">{shorten(c.peerId, 6)}</span>} · {assetOf(c)}
                </span>
                <StatusBadge tone={channelStateTone(c.state)}>{channelStateLabel(c.state)}</StatusBadge>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-xs tabular-nums">
                  {CHANNEL_LIST_COPY.SEND} {units(c, c.localBalance)} · {CHANNEL_LIST_COPY.RECEIVE} {units(c, c.remoteBalance)}
                </span>
                {closeButton(c)}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto" role="region" aria-label={CHANNEL_LIST_COPY.LABEL} tabIndex={0} data-testid="fiber-node-channels">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left font-mono text-xs text-muted-foreground border-b border-foreground/10">
                <th className="py-2 pl-2 pr-4 font-normal">Peer</th>
                <th className="py-2 pr-4 font-normal">Asset</th>
                <th className="py-2 pr-4 font-normal">State</th>
                <th className="py-2 pr-4 font-normal text-right">Can send</th>
                <th className="py-2 pr-4 font-normal text-right">Can receive</th>
                <th className="py-2 font-normal">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.channelId} className="border-b border-foreground/5 last:border-b-0">
                  <td className={cn("py-3 pl-2 pr-4 font-mono text-xs", statusRule(channelStateTone(c.state)))}>
                    {c.peerId === hubNodeId ? CHANNEL_LIST_COPY.HUB : shorten(c.peerId, 6)}
                  </td>
                  <td className="py-3 pr-4">{assetOf(c)}</td>
                  <td className="py-3 pr-4">
                    <StatusBadge tone={channelStateTone(c.state)}>{channelStateLabel(c.state)}</StatusBadge>
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs text-right tabular-nums">{units(c, c.localBalance)}</td>
                  <td className="py-3 pr-4 font-mono text-xs text-right tabular-nums">{units(c, c.remoteBalance)}</td>
                  <td className="py-3 text-right whitespace-nowrap">{closeButton(c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {closing && (
        <CloseConfirm
          key={closing.channelId}
          id={confirmId}
          title={CLOSE_COPY.TITLE(assetOf(closing), peerName(closing))}
          network={network}
          nodeLock={nodeLock}
          onKeep={() => setConfirming(null)}
          onConfirm={async (target) => {
            setConfirming(null);
            await onClose(closing, target);
          }}
        />
      )}
    </div>
  );
}

type Destination = "node" | "wallet";

/** "Close the CKB channel with the CKBolt hub?": the node's share to the node, or to an address the visitor gives. */
function CloseConfirm({
  id,
  title,
  network,
  nodeLock,
  onKeep,
  onConfirm,
}: {
  id: string;
  title: string;
  network: CkbAddressNetwork;
  nodeLock: Script | null;
  onKeep: () => void;
  onConfirm: (target: CloseTarget | null) => Promise<void>;
}) {
  const [to, setTo] = useState<Destination>("node");
  const [text, setText] = useState("");
  const destination = parseCkbDestination(text, network, nodeLock);
  const ready = to === "node" || destination.status === "ok";
  const choices: { value: Destination; label: string; note: string }[] = [
    { value: "node", label: CLOSE_COPY.TO_NODE, note: CLOSE_COPY.TO_NODE_NOTE },
    { value: "wallet", label: CLOSE_COPY.TO_WALLET, note: CLOSE_COPY.TO_WALLET_NOTE },
  ];
  const confirm = () => {
    if (to === "node") return void onConfirm(null);
    if (destination.status === "ok") void onConfirm({ script: destination.script, address: destination.address });
  };
  return (
    <div id={id} className={noteBox} role="group" aria-label={title} data-testid="fiber-node-close-confirm">
      <p className="text-sm font-medium">{title}</p>
      <div className="space-y-2">
        <p id={`${id}-to`} className="flex items-center gap-1 text-xs text-muted-foreground">
          {CLOSE_COPY.DESTINATION_LABEL}
          <InfoTip label={CLOSE_COPY.WALLET_TIP_LABEL} align="start">
            {CLOSE_COPY.WALLET_TIP}
          </InfoTip>
        </p>
        <div role="radiogroup" aria-labelledby={`${id}-to`} onKeyDown={onRadioGroupKeyDown} className="flex flex-wrap gap-2">
          {choices.map((choice) => (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={to === choice.value}
              tabIndex={to === choice.value ? 0 : -1}
              onClick={() => setTo(choice.value)}
              className={choiceChip}
            >
              <span className="block">{choice.label}</span>
              <span className="block font-mono text-xs opacity-70">{choice.note}</span>
            </button>
          ))}
        </div>
      </div>
      {to === "wallet" && (
        <DestinationField
          id="fiber-node-close-address"
          label={CLOSE_COPY.ADDRESS_LABEL}
          prefix={CKB_ADDRESS_PREFIX[network]}
          value={text}
          onChange={setText}
          destination={destination}
        />
      )}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          type="button"
          onClick={confirm}
          disabled={!ready}
          title={ready ? undefined : CLOSE_COPY.NEEDS_ADDRESS}
          className={pillButton}
        >
          {CLOSE_COPY.CONFIRM}
        </button>
        <button type="button" onClick={onKeep} className={textButton}>
          {CLOSE_COPY.KEEP}
        </button>
      </div>
    </div>
  );
}
