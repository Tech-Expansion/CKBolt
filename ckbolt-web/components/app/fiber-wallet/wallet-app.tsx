"use client";

import dynamic from "next/dynamic";
import { WALLET_CHROME } from "./copy";
import type { WalletView } from "./wallet-page";

// The wallet uses browser-only APIs (isolation, Web Locks, BroadcastChannel, crypto, storage), so it renders on the client
// only. fiber-js itself loads later still, when the visitor starts the node.
const FiberWalletPage = dynamic(() => import("./wallet-page").then((m) => m.FiberWalletPage), {
  ssr: false,
  loading: () => <p className="p-4 text-sm text-muted-foreground">{WALLET_CHROME.LOADING}</p>,
});

/** The Fiber node popup: /app/wallet in the header's popover (`frame`), and /app/fiber?view=wallet in a window (`window`). */
export function FiberWalletApp({ view }: { view: WalletView }) {
  return <FiberWalletPage view={view} />;
}
