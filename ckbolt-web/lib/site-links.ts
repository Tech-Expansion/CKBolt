import { FIBER_NODE_PAGE_PATH } from "@/lib/wallets/fiber-browser/constants";
import { FIBER_WALLET_PATH } from "@/lib/wallets/fiber-popup/constants";

/**
 * Which links of the site move client-side. A client-side move keeps the root layout, so the header's Fiber node keeps
 * its node running; a full load restarts it. Pages that need their own isolation headers must load in full, and so must
 * anything that is not one of the site's pages.
 */

/** Pages that get their isolation only from a full load: the node page and the wallet's iframe route. */
const FULL_LOAD_PATHS: readonly string[] = [FIBER_NODE_PAGE_PATH, FIBER_WALLET_PATH];
const API_PREFIX = "/api/";

/** The path of a same-site link ("/app?mode=swap#x" is "/app"), without a trailing slash. */
const pathOf = (href: string): string => href.split(/[?#]/)[0].replace(/(.)\/+$/, "$1");

/** True for a link to one of the site's own pages that may move client-side; false for the isolated pages and the rest. */
export function isClientNavigable(href: string): boolean {
  if (!href.startsWith("/") || href.startsWith("//")) return false;
  const path = pathOf(href);
  return !path.startsWith(API_PREFIX) && !FULL_LOAD_PATHS.includes(path);
}
