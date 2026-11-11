import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeployContext } from "../lib/context";
import { KIT_ENV_KEY, KIT_FILE, KIT_HAND_SECRETS,
  KIT_SECRET_BYTES, LND_SERVICES, LND_WALLET_PASSWORD_BYTES } from "../lib/constants";
import {
  envCompletionScript,
  envEntries,
  envProbeScript,
  missingEnvLines,
  parseEnvProbe,
  planEnvCompletion,
  secretFileScript,
  validateKitEnv,
} from "../lib/env-file";
import { walletPasswordPath } from "../lib/kit-paths";
import { publicIpOfSshHost } from "../lib/public-ip";
import { shellQuote } from "../lib/shell";

/** Marks the lines `testnet env` appends to the server's hub.env. */
const HUB_ENV_APPENDED_HEADER = "# Added from hub.env.example by `testnet env` (a newer kit has these settings).";

/** The keys of the kit's .env whose values the scripts may read: every key of the example except the secrets. */
export const readableEnvKeys = (exampleText: string): string[] =>
  [...envEntries(exampleText).keys()].filter((key) => KIT_SECRET_BYTES[key] === undefined && !KIT_HAND_SECRETS.includes(key));

/**
 * Creates or completes the server's .env and hub.env and the LND wallet passwords. Keeps every value already there
 * (the running sync's bitcoind RPC credentials included); each missing secret is generated on the server and never
 * leaves it. Stops with a sentence per contradiction (e.g. DEMO_ENABLED without the demo profile).
 */
export async function completeKitEnv(ctx: DeployContext): Promise<void> {
  const { kit, logger } = ctx;
  logger.step("Completing the kit's .env, hub.env and wallet passwords on the server");
  if (!(await kit.fileExists(KIT_FILE.ENV_EXAMPLE))) throw new Error("The kit is not on the server yet: run `testnet sync` first");

  const exampleText = readFileSync(join(ctx.paths.kitDir, KIT_FILE.ENV_EXAMPLE), "utf8");
  const readable = readableEnvKeys(exampleText);
  const probe = parseEnvProbe(await kit.run(envProbeScript(KIT_FILE.ENV, readable), { description: "read the .env keys" }), readable);
  const publicIp = probe.get(KIT_ENV_KEY.PUBLIC_IP)?.set ? null : await findPublicIp(ctx);
  const plan = planEnvCompletion({ exampleText, probe, secretBytes: KIT_SECRET_BYTES, publicIp });

  const problems = validateKitEnv(plan.values);
  if (problems.length > 0) throw new Error(`The kit's .env needs a change: ${problems.join("; ")}`);
  if (plan.fills.length > 0) {
    await kit.run(envCompletionScript(KIT_FILE.ENV, plan.fills), { description: "complete .env" });
    for (const fill of plan.fills) {
      logger.info(fill.kind === "secret" ? `.env: ${fill.key} generated on the server` : `.env: ${fill.key}=${fill.value}`);
    }
  } else {
    logger.info(".env already complete; nothing changed");
  }

  await completeHubEnv(ctx);
  await kit.makeSecretDirs([KIT_FILE.SECRETS_DIR, KIT_FILE.WALLET_SECRETS_DIR]);
  for (const service of LND_SERVICES) {
    await kit.run(secretFileScript(walletPasswordPath(service), LND_WALLET_PASSWORD_BYTES), { description: `${service} wallet password` });
  }
  logger.info(`LND wallet passwords in ${KIT_FILE.WALLET_SECRETS_DIR}/ (mode 600; kept when present)`);
}

/** PUBLIC_IP for a new .env: DEPLOY_PUBLIC_IP, else the SSH host's address. */
async function findPublicIp(ctx: DeployContext): Promise<string | null> {
  if (ctx.settings.publicIp) return ctx.settings.publicIp;
  const found = await publicIpOfSshHost(ctx.shell.target.host, ctx.runLocal);
  if (found) ctx.logger.info(`PUBLIC_IP: ${found} (the SSH host's address; set DEPLOY_PUBLIC_IP to override)`);
  return found;
}

/** Copies hub.env.example to hub.env when there is none, else appends the keys a newer example added. */
async function completeHubEnv(ctx: DeployContext): Promise<void> {
  const { kit, logger } = ctx;
  if (!(await kit.fileExists(KIT_FILE.HUB_ENV))) {
    await kit.run(`cp ${shellQuote(KIT_FILE.HUB_ENV_EXAMPLE)} ${shellQuote(KIT_FILE.HUB_ENV)}`, { description: "create hub.env" });
    logger.info("hub.env created from hub.env.example");
    return;
  }
  const exampleText = readFileSync(join(ctx.paths.kitDir, KIT_FILE.HUB_ENV_EXAMPLE), "utf8");
  const missing = missingEnvLines(exampleText, await kit.readText(KIT_FILE.HUB_ENV));
  if (missing.length === 0) {
    logger.info("hub.env already has every key of hub.env.example");
    return;
  }
  const appended = ["", HUB_ENV_APPENDED_HEADER, ...missing, ""].join("\n");
  await kit.run(`cat >> ${shellQuote(KIT_FILE.HUB_ENV)}`, { input: appended, description: "complete hub.env" });
  logger.info(`hub.env: added ${missing.map((line) => line.slice(0, line.indexOf("="))).join(", ")}`);
}
