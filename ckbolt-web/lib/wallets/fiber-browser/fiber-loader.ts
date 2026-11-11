import type { FiberLike } from "./fiber-js-adapter";

/**
 * A new fiber-js node, loaded on demand: the 15 MB bundle (WASM inlined, two workers, 100 MB of shared buffers) is
 * fetched only when the visitor starts a node, and only on the isolated page. In a build made for tests, a fake node
 * installed in `scope` replaces it (./fiber-test-hook.ts).
 */
export async function loadFiber(scope: Partial<Window> | undefined = typeof window === "undefined" ? undefined : window): Promise<FiberLike> {
  // Build-time switch (next.config.mjs): "1" only in builds made for the Playwright suite. Compared with a literal here,
  // not a shared constant, so every other build folds it to false and drops the branch and the hook module with it.
  if (process.env.NEXT_PUBLIC_CKBOLT_TEST_HOOKS === "1") {
    const fake = (await import("./fiber-test-hook")).installedTestNode(scope);
    if (fake) return fake;
  }
  const { Fiber } = await import("@nervosnetwork/fiber-js");
  return new Fiber();
}
