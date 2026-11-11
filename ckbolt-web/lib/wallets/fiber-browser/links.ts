import { validateCkbAddress } from "@/lib/payment-request";
import { FIBER_WALLET_WINDOW } from "@/lib/wallets/fiber-popup/constants";
import { FIBER_NODE_PAGE_PATH, FUND_ADDRESS_PARAM, FUND_NODE_PAGE_PATH } from "./constants";

/** The host of a URL, as the page names a service it reads from or links to; the text itself when it is not a URL. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The node page. Link to it with a plain <a> (a full navigation), never next/link: only a fresh load gets its headers. */
export const fiberNodePageHref = (): string => FIBER_NODE_PAGE_PATH;

/**
 * The wallet in a window of its own, for browsers that cannot isolate the header's popover: the node page, isolated
 * with COOP/COEP, in the wallet's layout (/app/fiber?view=wallet).
 */
export function fiberWalletWindowHref(): string {
  const params = new URLSearchParams({ [FIBER_WALLET_WINDOW.PARAM]: FIBER_WALLET_WINDOW.VALUE });
  return `${FIBER_NODE_PAGE_PATH}?${params.toString()}`;
}

/** True when the node page's query asks for the wallet's layout (the window fallback). */
export const isWalletWindowQuery = (value: string | string[] | undefined): boolean =>
  (Array.isArray(value) ? value[0] : value) === FIBER_WALLET_WINDOW.VALUE;

/**
 * The funding page for the node's address. Funding runs there because the CCC wallet popups (JoyID) do not work on the
 * isolated node page.
 */
export function fundNodeHref(address: string): string {
  const params = new URLSearchParams({ [FUND_ADDRESS_PARAM]: address });
  return `${FUND_NODE_PAGE_PATH}?${params.toString()}`;
}

/** The CKB testnet address a funding page is for (`?address=ckt1...`), or null when there is none or it is not one. */
export function readFundAddress(search: string): string | null {
  const address = new URLSearchParams(search).get(FUND_ADDRESS_PARAM)?.trim();
  if (!address) return null;
  try {
    return validateCkbAddress(address) === "testnet" ? address : null;
  } catch {
    return null;
  }
}
