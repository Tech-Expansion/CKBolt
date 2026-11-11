import type { StatusTone } from "@/lib/status-tone";
import { StatusDot } from "../../status";
import { WALLET_TONE_LABEL } from "./copy";

/** How a chosen Fiber node stands: ready, connecting or starting, needing a step, or not usable. */
export type WalletTone = keyof typeof WALLET_TONE_LABEL;

/** A node's state in the status colours: ready is green; a wait or a step to take amber; a failure red. */
export const WALLET_TONE_STATUS: Readonly<Record<WalletTone, StatusTone>> = {
  ok: "ok",
  wait: "pending",
  attention: "pending",
  problem: "error",
};

/** The dot after the chip's name: grey while nothing is chosen. Decorative: the button says the same in words. */
export function WalletStatusDot({ tone }: { tone: WalletTone | null }) {
  return <StatusDot tone={tone ? WALLET_TONE_STATUS[tone] : "off"} />;
}
