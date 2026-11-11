"use client";

import dynamic from "next/dynamic";

// The node page uses browser-only APIs (Web Locks, BroadcastChannel, crypto, storage), so it renders on the client only.
// fiber-js itself loads later still, when the visitor starts the node.
const FiberNodePage = dynamic(() => import("./fiber-node-page").then((m) => m.FiberNodePage), {
  ssr: false,
  loading: () => <p className="text-muted-foreground">Loading the node page…</p>,
});

export function FiberNodeApp() {
  return <FiberNodePage />;
}
