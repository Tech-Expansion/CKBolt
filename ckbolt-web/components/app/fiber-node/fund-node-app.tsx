"use client";

import dynamic from "next/dynamic";

// The wallet connector touches browser-only APIs, so the funding form renders on the client only.
const FundNodePage = dynamic(() => import("./fund-node-page").then((m) => m.FundNodePage), {
  ssr: false,
  loading: () => <p className="text-muted-foreground">Loading wallet connector…</p>,
});

export function FundNodeApp() {
  return <FundNodePage />;
}
