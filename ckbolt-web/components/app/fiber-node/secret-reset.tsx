"use client";

import { createContext, useContext, useEffect, useRef } from "react";

/**
 * A count that goes up whenever the wallet hides what is typed in it: another tab is chosen, the popover or the browser
 * tab is hidden. Forms that hold a password clear it then, so it does not linger in a panel that stays mounted. Outside
 * the wallet (the node page) nothing raises it.
 */
const SecretResetContext = createContext(0);

export const SecretResetProvider = SecretResetContext.Provider;

/** Calls `clear` each time the count goes up. */
export function useSecretReset(clear: () => void): void {
  const signal = useContext(SecretResetContext);
  const latest = useRef(clear);
  useEffect(() => {
    latest.current = clear;
  });
  useEffect(() => {
    if (signal > 0) latest.current();
  }, [signal]);
}
