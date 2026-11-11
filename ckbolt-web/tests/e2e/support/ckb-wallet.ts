import type { Page } from "@playwright/test";
import { lockScriptToAddress } from "../../../lib/wallets/fiber-byo/funding";
import { secpLock, type Script } from "../fiber-byo-fakes";

/*
 * A stand-in for the UTXO Global extension's CKB signer, as CCC's connector finds it on `window.utxoGlobal`: it reports
 * one address and lets the test sign or refuse. Used by the funding page's spec and by the node page's, where the
 * visitor's wallet only gives its address.
 */

export type SignDecision = "sign" | "reject";

export interface FakeCkbWallet {
  lock: Script;
  address: string;
  /** Every transaction the page asked the wallet to sign, as the extension received it (bigints as strings). */
  signRequests: { outputs: { capacity: string; lock: Script; type?: Script }[]; outputsData: string[] }[];
  decision: SignDecision;
}

export async function installCkbWallet(page: Page, opts: { lock?: Script; address?: string } = {}): Promise<FakeCkbWallet> {
  const lock = opts.lock ?? secpLock();
  const wallet: FakeCkbWallet = { lock, address: opts.address ?? lockScriptToAddress(lock), signRequests: [], decision: "sign" };
  await page.exposeFunction("__fbyoWalletSign", (json: string) => {
    wallet.signRequests.push(JSON.parse(json));
    return wallet.decision;
  });
  await page.addInitScript(
    ({ address }) => {
      const w = window as unknown as Record<string, unknown>;
      const listeners: Record<string, Set<() => void>> = {};
      const publicKey = `0x02${"11".repeat(32)}`;
      const signer = (network: string, account: string) => ({
        connect: async () => {},
        isConnected: async () => true,
        getAccount: async () => [account],
        getPublicKey: async () => [{ address: account, publicKey }],
        getNetwork: async () => network,
        switchNetwork: async () => {},
        signMessage: async () => {
          throw new Error("This test wallet does not sign messages.");
        },
        signTransaction: async (tx: unknown) => {
          const json = JSON.stringify(tx, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
          const decision = await (w.__fbyoWalletSign as (j: string) => Promise<string>)(json);
          if (decision === "reject") throw new Error("User rejected the request.");
          return tx;
        },
        on: (event: string, cb: () => void) => {
          (listeners[event] ??= new Set()).add(cb);
        },
        removeListener: (event: string, cb: () => void) => {
          listeners[event]?.delete(cb);
        },
      });
      // Lets a test play the extension switching account or network.
      w.__fbyoWalletEmit = (event: string) => listeners[event]?.forEach((cb) => cb());
      w.utxoGlobal = {
        ckbSigner: signer("nervos_testnet", address),
        bitcoinSigner: signer("btc_testnet", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"),
        dogeSigner: signer("dogecoin_testnet", "nVWwTF3gtG6cG8dCSwAwHM4h6yoq76mTnQ"),
      };
    },
    { address: wallet.address },
  );
  return wallet;
}

/** Picks the fake UTXO Global wallet's CKB account in CCC's connector, once it is open. */
export async function chooseUtxoGlobal(page: Page) {
  const connector = page.locator("ccc-connector");
  await connector.getByText("UTXO Global").click();
  await connector.getByText("CKB", { exact: true }).click();
}
