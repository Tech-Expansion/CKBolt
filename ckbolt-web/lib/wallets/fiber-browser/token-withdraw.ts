import type { FiberAssetId } from "@/lib/hub/contract";
import type { WithdrawToken } from "./ccc-withdraw";
import { sameScript } from "./scripts";
import type { WalletToken } from "./tokens";
import type { WhitelistEntry } from "./udt-whitelist";

/**
 * Tokens the node may hold on chain and send away with Withdraw: closing a token channel, or a faucet paying the node's
 * address, leaves them there. Wallets such as UTXO Global may not show a token like cWBTC, so the node lists and sends it.
 */
export interface WithdrawableToken {
  id: FiberAssetId;
  symbol: string;
  decimals: number;
  token: WithdrawToken;
}

/**
 * The hub's tokens (not CKB) the node can withdraw: each with the whitelist entry the hub gives for it, whose cell deps
 * a transfer of the token needs. A token without a checked entry is left out: its code could not be named.
 */
export function withdrawableTokens(tokens: readonly WalletToken[], whitelist: readonly WhitelistEntry[]): WithdrawableToken[] {
  return tokens.flatMap((t) => {
    if (!t.udtTypeScript) return [];
    const entry = whitelist.find((w) => sameScript(w.script, t.udtTypeScript!));
    return entry ? [{ id: t.id, symbol: t.symbol, decimals: t.decimals, token: { symbol: t.symbol, script: entry.script, cellDeps: entry.cellDeps } }] : [];
  });
}
