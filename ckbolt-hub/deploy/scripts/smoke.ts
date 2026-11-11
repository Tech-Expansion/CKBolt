import { createDefaultContext } from "./lib/context";
import { runMain } from "./lib/main";
import { renderEvidence, runSmoke, smokeSucceeded } from "./smoke/run-smoke";
import { smokeOptions } from "./smoke/smoke-options";

/**
 * testnet:smoke: a real swap each way on the deployment (demo nodes pay and receive; the CKB to BTC payout goes to an
 * invoice of the Mutinynet faucet's node). Prints the evidence and exits 1 unless every swap succeeded with
 * sha256(preimage) == payment hash.
 *   npm --prefix deploy run testnet:smoke -- [--direction ln_to_fiber|fiber_to_ln|both] [--asset CKB|RUSD] [--sats N]
 */
/** A blank line between the evidence of each swap. */
const EVIDENCE_SEPARATOR = "\n\n";

async function main(): Promise<number> {
  const ctx = createDefaultContext();
  const evidence = await runSmoke(ctx, smokeOptions(ctx.settings, process.argv.slice(2)));
  ctx.logger.raw(["", ...evidence.map(renderEvidence)].join(EVIDENCE_SEPARATOR));
  return evidence.every(smokeSucceeded) ? 0 : 1;
}

runMain("testnet:smoke", main);
