"use client";

import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import { HubClient } from "@/lib/hub/client";

const HubClientContext = createContext<HubClient | null>(null);

/** Gives the hub hooks below it a client of the caller's choice (another base URL, a fake fetch). */
export function HubClientProvider({ client, children }: { client: HubClient; children: ReactNode }) {
  return createElement(HubClientContext.Provider, { value: client }, children);
}

/** The nearest provided hub client, or one for the same-origin proxy. */
export function useHubClient(): HubClient {
  const provided = useContext(HubClientContext);
  const fallback = useMemo(() => new HubClient(), []);
  return provided ?? fallback;
}
