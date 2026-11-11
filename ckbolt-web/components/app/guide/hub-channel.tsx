"use client";

import { useId, useState, type FormEvent } from "react";
import { formatSats } from "@/lib/swap/format";
import { readNodeId, type HubChannelStatus } from "@/lib/wallets/lightning/hub-channel";
import { InfoTip } from "../swap/info-tip";
import { ErrorLine } from "../swap/primary-button";
import { monoLabel, pillButton, textInput } from "../swap/wallets/styles";
import { HUB_CHANNEL_COPY } from "./copy";
import { useHubLightningChannel } from "./use-hub-lightning-channel";

/**
 * "Get a Lightning channel from the hub" on the guide's hub card, under the hub's Lightning address, while the hub
 * offers channels (GET /v1/lightning/node): the visitor pastes their wallet's node id and asks; the line then follows
 * the channel from Opening to Ready. Why it is needed sits behind the "?".
 */
export function HubChannelRequest() {
  const [text, setText] = useState("");
  const pubkey = readNodeId(text);
  const hub = useHubLightningChannel(pubkey);
  const titleId = useId();
  const inputId = useId();
  const errorId = useId();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!hub.requesting) void hub.request();
  };

  return (
    <section aria-labelledby={titleId} className="space-y-3 border border-foreground/10 px-4 py-3" data-testid="wallet-lightning-channel">
      <h4 id={titleId} className="flex items-center gap-1 text-sm font-medium">
        {HUB_CHANNEL_COPY.TITLE}
        <InfoTip label={HUB_CHANNEL_COPY.TIP_LABEL} align="end">
          {HUB_CHANNEL_COPY.TIP}
        </InfoTip>
      </h4>
      <form onSubmit={submit} className="space-y-2">
        <label htmlFor={inputId} className={`block ${monoLabel}`}>
          {HUB_CHANNEL_COPY.NODE_ID_LABEL}
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
          placeholder={HUB_CHANNEL_COPY.NODE_ID_PLACEHOLDER}
          aria-invalid={hub.error !== null && pubkey === null}
          aria-describedby={hub.error ? errorId : undefined}
          className={textInput}
          data-testid="wallet-lightning-channel-pubkey"
        />
        {hub.status === "none" ? (
          <button type="submit" className={pillButton} disabled={hub.requesting} data-testid="wallet-lightning-channel-request">
            {hub.requesting ? HUB_CHANNEL_COPY.REQUESTING : HUB_CHANNEL_COPY.REQUEST}
          </button>
        ) : (
          <p className="text-sm" role="status" data-testid="wallet-lightning-channel-status">
            {statusLine(hub.status, hub.channel?.walletBalanceSats ?? null)}
          </p>
        )}
      </form>
      <div id={errorId} aria-live="polite">
        {hub.error && <ErrorLine error={hub.error} label={HUB_CHANNEL_COPY.ERROR_LABEL} testId="wallet-lightning-channel-error" />}
      </div>
    </section>
  );
}

function statusLine(status: Exclude<HubChannelStatus, "none">, walletSats: string | null): string {
  switch (status) {
    case "opening":
      return HUB_CHANNEL_COPY.OPENING;
    case "ready":
      return HUB_CHANNEL_COPY.READY(formatSats(walletSats ?? "0"));
    case "closing":
      return HUB_CHANNEL_COPY.CLOSING;
  }
}
