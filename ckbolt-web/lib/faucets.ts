/**
 * Where testers claim test tokens for the browser node, by the hub's asset id. CKB's own faucet is in
 * lib/wallets/fiber-browser/constants.ts (CKB_TESTNET_FAUCET_URL); these are the tokens a CKBolt hub serves.
 *
 * cWBTC: NEXT_PUBLIC_CWBTC_FAUCET_URL names the faucet at build time (CKBolt's own runs at
 * https://ckbolt-faucet.texlabs.org); without it, the CKB testnet cWBTC faucet.
 */

/** cWBTC's faucet when NEXT_PUBLIC_CWBTC_FAUCET_URL is not set: 100 test cWBTC per claim on CKB testnet. */
export const CWBTC_FAUCET_DEFAULT_URL = "https://faucet-cwbtc.ckb.dev";

/** The asset id the hub gives cWBTC. */
export const CWBTC_ASSET_ID = "CWBTC";

/** The link's text: the token by its symbol. */
export const FAUCET_LINK_LABEL = (symbol: string) => `Get test ${symbol}`;

/** `configured` when it is an http(s) URL, else `fallback`. */
function httpUrlOr(configured: string | undefined, fallback: string): string {
  const text = configured?.trim();
  if (!text) return fallback;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

/** The configured cWBTC faucet (http or https), else the default. */
export const cwbtcFaucetUrl = (configured: string | undefined = process.env.NEXT_PUBLIC_CWBTC_FAUCET_URL): string =>
  httpUrlOr(configured, CWBTC_FAUCET_DEFAULT_URL);

/** A faucet link for one token. */
export interface TokenFaucet {
  id: string;
  symbol: string;
  href: string;
}

/** The faucets of the tokens in `tokens` (those the hub serves), in their order; tokens without a known faucet are left out. */
export function tokenFaucets(tokens: readonly { id: string; symbol: string }[], cwbtcUrl: string = cwbtcFaucetUrl()): TokenFaucet[] {
  return tokens.flatMap((t) => (t.id === CWBTC_ASSET_ID ? [{ id: t.id, symbol: t.symbol, href: cwbtcUrl }] : []));
}
