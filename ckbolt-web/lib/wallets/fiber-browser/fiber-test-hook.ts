import type { FiberLike } from "./fiber-js-adapter";

/**
 * TEST HOOK, only in builds made for the Playwright suite (`npm run build:test`, NEXT_PUBLIC_CKBOLT_TEST_HOOKS=1):
 * ./fiber-loader.ts imports this module behind that build-time switch, so a production build carries neither the code
 * nor the name. Tests install a fake node before the page loads, and the page uses it instead of fiber-js:
 *
 * ```ts
 * await page.addInitScript(() => {
 *   window.__ckboltTestFiberNode = {
 *     getDefaultConfig: () => "fiber:\n  bootnode_addrs: []\n",           // optional
 *     start: async (config, fiberKey, ckbKey, chainSpec, logLevel, dbPrefix) => {},
 *     invokeCommand: async (name, [params]) => { ...answer node_info, connect_peer, list_peers, open_channel,
 *       list_channels, shutdown_channel, new_invoice, get_invoice, send_payment, get_payment like fnn 0.9.1... },
 *     stop: async () => {},
 *   };
 * });
 * ```
 *
 * The value may also be a function that returns such an object (called once per start). Commands and their wire shapes
 * are in ./rpc-types.ts. Nothing else changes with the hook: keys, the Web Lock, the bridge and the hub calls stay real.
 */
export const TEST_FIBER_NODE_GLOBAL = "__ckboltTestFiberNode";

type TestFiberNode = FiberLike | (() => FiberLike);

declare global {
  interface Window {
    [TEST_FIBER_NODE_GLOBAL]?: TestFiberNode;
  }
}

/** The fake node a test installed in `scope`, or null. */
export function installedTestNode(scope: Partial<Window> | undefined): FiberLike | null {
  const hook = scope?.[TEST_FIBER_NODE_GLOBAL];
  if (!hook) return null;
  return typeof hook === "function" ? hook() : hook;
}
