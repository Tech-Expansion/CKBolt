import { runMain } from "../scripts/lib/main";
import { checkLiquidity } from "./live/liquidity.checks";
import { createLiveContext } from "./live/live-context";
import { checkProtocol } from "./live/protocol.checks";
import { CheckRunner } from "./live/runner";
import { checkSecretsAndHubEnv } from "./live/secrets.checks";
import { checkStack } from "./live/stack.checks";

/**
 * Checks a running, bootstrapped devnet against its spec: `npx tsx test/check.ts` in devnet/ (after npm run bootstrap
 * or npm run up). Read-only for funds: its own invoices are cancelled, so channel balances do not move.
 */
async function check(): Promise<void> {
  const runner = new CheckRunner();
  const live = await createLiveContext();
  await checkStack(live, runner);
  await checkSecretsAndHubEnv(live, runner);
  await checkLiquidity(live, runner);
  await checkProtocol(live, runner);
  runner.printSummary();
  if (runner.failed.length > 0) throw new Error(`${runner.failed.length} devnet check(s) failed`);
}

runMain("check", check);
