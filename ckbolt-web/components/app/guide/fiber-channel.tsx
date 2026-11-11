"use client";

import { useId, useState, type FormEvent } from "react";
import type { AssetDto, FiberAssetId, FiberNodeDto } from "@/lib/hub/contract";
import { FNN_DEFAULT_RPC_URL } from "@/lib/wallets/fiber-byo/constants";
import { FIBER_CHANNEL_MESSAGE } from "@/lib/wallets/fiber-byo/hub-fiber-channel";
import { connectPeerRequest } from "@/lib/wallets/fiber-byo/rpc-commands";
import { assetDecimals, formatAssetUnits } from "@/lib/wallets/fiber-browser/tokens";
import { whitelistEntryOf, whitelistEntryYaml } from "@/lib/wallets/fiber-browser/udt-whitelist";
import { readNodeId } from "@/lib/wallets/lightning/hub-channel";
import { InfoTip } from "../swap/info-tip";
import { CopyableBlock, NodeCommand } from "../swap/node-command";
import { ErrorLine } from "../swap/primary-button";
import { monoLabel, pillButton, textInput } from "../swap/wallets/styles";
import { onRadioGroupKeyDown } from "../ui";
import { FIBER_CHANNEL_COPY } from "./copy";
import { useHubFiberChannel } from "./use-hub-fiber-channel";

/** The tokens the hub opens channels in, with what it puts in, in the hub's order. */
function offeredTokens(node: FiberNodeDto, assets: readonly AssetDto[]): { id: FiberAssetId; symbol: string; amount: string }[] {
  if (!node.inbound.enabled) return [];
  return node.assets.flatMap((asset) => {
    const amount = node.inbound.amounts[asset.id];
    if (!amount) return [];
    const symbol = assets.find((a) => a.id === asset.id)?.symbol ?? asset.id;
    return [{ id: asset.id, symbol, amount: formatAssetUnits(amount, assetDecimals(asset.id, assets), symbol) }];
  });
}

/** "connect_peer" for the hub's first TCP address (with its peer id), for an external node. */
export function ConnectCommand({ address }: { address: string }) {
  return (
    <NodeCommand
      label={FIBER_CHANNEL_COPY.CONNECT_LABEL}
      tip={FIBER_CHANNEL_COPY.CONNECT_TIP(FNN_DEFAULT_RPC_URL)}
      request={connectPeerRequest(address)}
      testId="hub-card-fiber-connect"
    />
  );
}

/**
 * "Get a Fiber channel from the hub" on the guide's hub card, for an external node: the visitor pastes the node's id and
 * picks a token; for a token, the whitelist entry the node needs to accept it; the line then follows the channel from
 * Opening to Ready.
 */
export function FiberChannelRequest({ node, assets }: { node: FiberNodeDto; assets: readonly AssetDto[] }) {
  const tokens = offeredTokens(node, assets);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<FiberAssetId | null>(null);
  const asset = picked ?? tokens[0]?.id ?? null;
  const nodeId = readNodeId(text);
  const hub = useHubFiberChannel(nodeId, asset);
  const titleId = useId();
  const inputId = useId();
  const errorId = useId();
  if (tokens.length === 0) return null;

  const token = tokens.find((t) => t.id === asset) ?? tokens[0];
  const whitelist = whitelistEntryOf(node.assets.find((a) => a.id === asset)?.udtWhitelist);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!hub.requesting) void hub.request();
  };

  return (
    <section aria-labelledby={titleId} className="space-y-3 border border-foreground/10 px-4 py-3" data-testid="hub-card-fiber-channel">
      <h4 id={titleId} className="flex items-center gap-1 text-sm font-medium">
        {FIBER_CHANNEL_COPY.TITLE}
        <InfoTip label={FIBER_CHANNEL_COPY.TIP_LABEL} align="end">
          {FIBER_CHANNEL_COPY.TIP}
        </InfoTip>
      </h4>
      <form onSubmit={submit} className="space-y-2">
        <label htmlFor={inputId} className={`block ${monoLabel}`}>
          {FIBER_CHANNEL_COPY.NODE_ID_LABEL}
        </label>
        <input
          id={inputId}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={FIBER_CHANNEL_COPY.NODE_ID_PLACEHOLDER}
          aria-invalid={hub.error?.line === FIBER_CHANNEL_MESSAGE.NODE_ID_INVALID}
          aria-describedby={hub.error ? errorId : undefined}
          className={textInput}
          data-testid="hub-card-fiber-channel-node-id"
        />
        {tokens.length > 1 && (
          <div role="radiogroup" aria-label={FIBER_CHANNEL_COPY.TOKEN_LABEL} onKeyDown={onRadioGroupKeyDown} className="space-y-1">
            {tokens.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={t.id === asset}
                tabIndex={t.id === asset ? 0 : -1}
                onClick={() => setPicked(t.id)}
                className="flex min-h-10 w-full items-center gap-2 text-left text-sm"
                data-testid={`hub-card-fiber-channel-token-${t.id}`}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-foreground/40" aria-hidden="true">
                  {t.id === asset && <span className="h-2 w-2 rounded-full bg-foreground" />}
                </span>
                {FIBER_CHANNEL_COPY.TOKEN_OPTION(t.symbol, t.amount)}
              </button>
            ))}
          </div>
        )}
        {whitelist && (
          <CopyableBlock
            label={FIBER_CHANNEL_COPY.WHITELIST_LABEL(token.symbol)}
            tip={FIBER_CHANNEL_COPY.WHITELIST_TIP}
            text={["ckb:", "  udt_whitelist:", ...whitelistEntryYaml(whitelist, "    ")].join("\n")}
            copyLabel={FIBER_CHANNEL_COPY.COPY_WHITELIST}
            testId="hub-card-fiber-whitelist"
          />
        )}
        {hub.status === "none" ? (
          <button type="submit" className={pillButton} disabled={hub.requesting} data-testid="hub-card-fiber-channel-request">
            {hub.requesting ? FIBER_CHANNEL_COPY.REQUESTING : FIBER_CHANNEL_COPY.REQUEST}
          </button>
        ) : (
          <p className="text-sm" role="status" data-testid="hub-card-fiber-channel-status">
            {hub.status === "opening"
              ? FIBER_CHANNEL_COPY.OPENING
              : hub.status === "closing"
                ? FIBER_CHANNEL_COPY.CLOSING
                : FIBER_CHANNEL_COPY.READY(formatAssetUnits(hub.channel?.hubBalance ?? "0", assetDecimals(token.id, assets), token.symbol))}
          </p>
        )}
      </form>
      <div id={errorId} aria-live="polite">
        {hub.error && <ErrorLine error={hub.error} label={FIBER_CHANNEL_COPY.ERROR_LABEL} testId="hub-card-fiber-channel-error" />}
      </div>
    </section>
  );
}
