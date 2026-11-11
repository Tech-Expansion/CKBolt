"use client";

import dynamic from "next/dynamic";

// The tabs read the URL and the browser's storage (the Fiber node's choice), so they render on the client only.
const AppModes = dynamic(() => import("./app-modes").then((m) => m.AppModes), {
  ssr: false,
  loading: () => <p className="text-muted-foreground">Loading the app…</p>,
});

export function AppShell() {
  return <AppModes />;
}
