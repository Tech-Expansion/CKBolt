import { RUNNING_STATE } from "../lib/compose-state";
import { activeServices, serviceStates, waitOptions, type DeployContext } from "../lib/context";
import { KIT_FILE, LND_STATE, LND_WALLET_EXISTS_STATES, PENDING_FILE_SUFFIX, SECRET_FILE_MODE, type LndService } from "../lib/constants";
import { walletSeedPath } from "../lib/kit-paths";
import { waitFor } from "../lib/poll";
import { shellJoin, shellQuote } from "../lib/shell";

/** Exit code of the wallet script when a seed file is already there (it never overwrites one). */
const SEED_FILE_EXISTS_EXIT_CODE = 3;

/**
 * The script that creates the wallet on the server: lnd/init-wallet.sh runs inside the LND container (GenSeed and
 * InitWallet over LND's container-local REST, with the unlock password LND already reads) and its only output, the 24
 * seed words, goes into the seed file with mode 600. The seed never reaches this machine or any log.
 */
export function createWalletScript(service: LndService): string {
  const seed = shellQuote(walletSeedPath(service));
  const pending = shellQuote(`${walletSeedPath(service)}${PENDING_FILE_SUFFIX}`);
  const exec = shellJoin(["docker", "compose", "exec", "-T", service, "sh", "-s"]);
  return [
    "set -eu",
    "umask 077",
    `if [ -e ${seed} ]; then`,
    `  echo "${walletSeedPath(service)} already exists: move it away (after keeping a copy) to create a new wallet" >&2`,
    `  exit ${SEED_FILE_EXISTS_EXIT_CODE}`,
    "fi",
    `if ! ${exec} < ${shellQuote(KIT_FILE.LND_INIT_WALLET_SCRIPT)} > ${pending}; then rm -f ${pending}; exit 1; fi`,
    `mv ${pending} ${seed}`,
    `chmod ${SECRET_FILE_MODE} ${seed}`,
  ].join("\n");
}

/**
 * Creates an LND node's wallet without a prompt, once. A node that already has a wallet is left alone. Afterwards LND
 * unlocks itself at every start (wallet-unlock-password-file).
 */
export async function createWallet(ctx: DeployContext, service: LndService): Promise<void> {
  ctx.logger.step(`Creating the ${service} wallet`);
  if (!(await activeServices(ctx)).has(service)) throw new Error(`${service} is not part of this deployment (COMPOSE_PROFILES in the server's .env)`);
  if ((await serviceStates(ctx)).get(service)?.state !== RUNNING_STATE) throw new Error(`${service} is not running: start it with \`testnet up ${service}\``);
  const lnd = ctx.lnd[service];
  const state = await waitFor(
    `${service} to answer`,
    async () => {
      const current = await lnd.state();
      return current === null || current === LND_STATE.WAITING_TO_START ? undefined : current;
    },
    waitOptions(ctx, true),
  );
  if (LND_WALLET_EXISTS_STATES.includes(state)) {
    ctx.logger.info(`${service} already has a wallet (state ${state}); nothing to do`);
    return;
  }
  if (state !== LND_STATE.NON_EXISTING) throw new Error(`${service} is in state ${state}; expected ${LND_STATE.NON_EXISTING}`);

  await ctx.kit.run(createWalletScript(service), { description: `create the ${service} wallet` });
  await waitFor(
    `${service} to unlock its new wallet`,
    async () => {
      const current = await lnd.state();
      return current !== null && LND_WALLET_EXISTS_STATES.includes(current) ? current : undefined;
    },
    waitOptions(ctx, true),
  );
  const seedFile = `${ctx.settings.remoteDir}/${walletSeedPath(service)}`;
  ctx.logger.info(`wallet created. Its 24-word seed is on the server only, in ${seedFile} (mode 600).`);
  ctx.logger.info(`Copy it offline now, e.g.  scp ${ctx.shell.target.host}:${seedFile} .  then delete the local copy once written down.`);
}
