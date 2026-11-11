import { runTestnetCommand } from "./cli/testnet-cli";
import { createDefaultContext } from "./lib/context";
import { runMain } from "./lib/main";

/**
 * The deploy kit's commands, run from this machine against the server named by DEPLOY_SSH_HOST:
 *   npm --prefix deploy run testnet -- <command> [arguments]
 * `npm --prefix deploy run testnet` alone lists them. deploy/README.md is the runbook.
 */
runMain("testnet", () => runTestnetCommand(process.argv.slice(2), createDefaultContext));
