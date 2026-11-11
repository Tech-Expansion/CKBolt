import { serviceImageOfConfig } from "../lib/compose-state";
import type { DeployContext } from "../lib/context";
import { ADD_TOKEN, HUB_SOURCE_PATHS, INCOMING_DIR_SUFFIX, KIT_FILE, SERVICE, SHELL_COMMAND_NOT_FOUND_EXIT_CODE } from "../lib/constants";
import { collectEntries, collectPaths } from "../lib/kit-files";
import { shellJoin, shellQuote } from "../lib/shell";
import { RemoteCommandError } from "../lib/ssh";
import { createTarGz, type TarEntry } from "../lib/tar";

const BYTES_PER_KIB = 1_024;

/** Unpacks the archive on stdin into `dir` (created when missing); files keep the server user as owner. */
export const unpackScript = (dir: string): string => `mkdir -p ${shellQuote(dir)} && tar -xzf - -C ${shellQuote(dir)} --no-same-owner`;

/**
 * Unpacks the archive on stdin into a fresh `<dir>.incoming`, then swaps it in for `dir`, so files deleted locally do
 * not linger and a failed upload leaves the previous source in place.
 */
export function replaceDirScript(dir: string): string {
  const target = shellQuote(dir);
  const incoming = shellQuote(`${dir}${INCOMING_DIR_SUFFIX}`);
  return [
    `rm -rf ${incoming}`,
    `mkdir -p ${incoming}`,
    `tar -xzf - -C ${incoming} --no-same-owner`,
    `rm -rf ${target}`,
    `mv ${incoming} ${target}`,
  ].join(" && ");
}

const describeUpload = (entries: readonly TarEntry[], archive: Buffer): string =>
  `${entries.length} files, ${Math.ceil(archive.length / BYTES_PER_KIB)} KiB compressed`;

/** The command that regenerates fnn's whitelists from the server's hub.env, typed as-is in the kit folder. */
export const REGENERATE_WHITELISTS_COMMAND = shellJoin([ADD_TOKEN.PYTHON, ADD_TOKEN.SCRIPT, ...ADD_TOKEN.REGENERATE_ARGS]);

/**
 * The kit's entries with fnn's whitelisted configs moved under KIT_FILE.SYNC_TEMPLATES_DIR: the upload never replaces
 * the files fnn runs, so a sync that cannot regenerate them leaves the server's whitelist as it was.
 */
export const asWhitelistTemplates = (entries: readonly TarEntry[]): TarEntry[] =>
  entries.map((entry) =>
    (KIT_FILE.FNN_WHITELIST_FILES as readonly string[]).includes(entry.path)
      ? { ...entry, path: `${KIT_FILE.SYNC_TEMPLATES_DIR}/${entry.path}` }
      : entry,
  );

/**
 * Copies the uploaded templates into place: each file the server does not have yet (a first sync), or every one with
 * `overwrite` (a hub.env on the legacy asset variables, whose whitelists are the repo's).
 */
export function installTemplatesScript(overwrite: boolean): string {
  return KIT_FILE.FNN_WHITELIST_FILES.map((path) => {
    const template = shellQuote(`${KIT_FILE.SYNC_TEMPLATES_DIR}/${path}`);
    const target = shellQuote(path);
    const copy = `cp -p ${template} ${target}`;
    return overwrite ? `{ ! test -f ${template} || ${copy}; }` : `{ test -f ${target} || ! test -f ${template} || ${copy}; }`;
  }).join(" && ");
}

/**
 * Uploads the kit (deploy/testnet) into the remote kit folder, fnn's whitelisted configs as templates
 * (asWhitelistTemplates), and the hub source the images build from into its src/ folder, then regenerates fnn's
 * whitelists from the server's hub.env (regenerateWhitelists). Never uploads .env, hub.env, secrets/, data/,
 * node_modules/ or seeds, and never deletes anything of the kit folder on the server (its .env, hub.env and secrets stay
 * as they are).
 */
export async function syncKit(ctx: DeployContext): Promise<void> {
  const { remoteDir } = ctx.settings;
  ctx.logger.step(`Uploading the kit to ${ctx.shell.target.host}:${remoteDir}`);
  const kitEntries = asWhitelistTemplates(collectEntries(ctx.paths.kitDir));
  const kitArchive = createTarGz(kitEntries);
  await ctx.shell.exec(unpackScript(remoteDir), { input: kitArchive, description: "unpack the kit" });
  ctx.logger.info(`kit: ${describeUpload(kitEntries, kitArchive)}`);

  const sourceDir = `${remoteDir}/${KIT_FILE.SOURCE_DIR}`;
  const sourceEntries = collectPaths(ctx.paths.hubRoot, HUB_SOURCE_PATHS);
  const sourceArchive = createTarGz(sourceEntries);
  await ctx.shell.exec(replaceDirScript(sourceDir), { input: sourceArchive, description: "unpack the hub source" });
  ctx.logger.info(`hub source -> ${sourceDir}: ${describeUpload(sourceEntries, sourceArchive)}`);

  await regenerateWhitelists(ctx);
}

/**
 * The upload put the repo's fnn/hub.yml and fnn/demo.yml under KIT_FILE.SYNC_TEMPLATES_DIR, leaving the files fnn runs
 * alone. add_token.py --regenerate --apply --template-dir generates both from those templates and the server's hub.env
 * (never uploaded; its FIBER_ASSETS may hold tokens the repo's copies do not), compares the result with the files fnn
 * runs, and writes, backs up and restarts fnn-hub or fnn-demo only where they differ; hub.env and the hub stay as they
 * are. Skipped, with what to run by hand, while the server cannot run it yet: before `testnet env` (no .env or
 * hub.env), before the hub image is built or while it predates the generator, or without python3; the server's files
 * then stay as they were, and only a file it does not have yet is copied from its template. A hub.env on the legacy
 * asset variables takes the repo's whitelists as they are. Any other failure fails the sync; the upload is done and the
 * files fnn runs are unchanged unless add_token.py says it wrote them.
 */
export async function regenerateWhitelists(ctx: DeployContext): Promise<void> {
  const { remoteDir } = ctx.settings;
  ctx.logger.step("Regenerating the fnn whitelists from the server's hub.env");
  const byHand = `run \`${REGENERATE_WHITELISTS_COMMAND}\` in ${remoteDir}`;
  const missing = await missingKitFiles(ctx, [KIT_FILE.ENV, KIT_FILE.HUB_ENV]);
  if (missing.length > 0) {
    await installTemplates(ctx, false);
    ctx.logger.info(`skipped: no ${missing.join(" or ")} on the server yet. After \`testnet env\` and \`testnet build hub\`, ${byHand}`);
    return;
  }
  if (!(await isHubImageBuilt(ctx))) {
    await installTemplates(ctx, false);
    ctx.logger.warn(`fnn whitelists not regenerated: the hub image is not built on the server yet. Run \`testnet build hub\`, then ${byHand}`);
    return;
  }

  const result = await ctx.kit.tryRun(REGENERATE_WHITELISTS_COMMAND, { timeoutMs: ctx.settings.timeouts.waitMs });
  for (const line of result.stdout.split("\n").filter((text) => text.trim() !== "")) ctx.logger.info(line);
  if (result.exitCode === 0 && !result.timedOut) return;
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode === SHELL_COMMAND_NOT_FOUND_EXIT_CODE) {
    await installTemplates(ctx, false);
    ctx.logger.warn(`fnn whitelists not regenerated: ${ADD_TOKEN.PYTHON} is not installed on the server. Install it, then ${byHand}`);
  } else if (ADD_TOKEN.GENERATOR_MISSING.test(output)) {
    await installTemplates(ctx, false);
    ctx.logger.warn(
      "fnn whitelists not regenerated: the hub image on the server predates the whitelist generator; fnn/hub.yml and " +
        `fnn/demo.yml stay as the server had them. Run \`testnet build hub\`, then ${byHand}, then \`testnet up hub\` to recreate the hub`,
    );
  } else if (ADD_TOKEN.NO_FIBER_ASSETS.test(output)) {
    await installTemplates(ctx, true);
    ctx.logger.info("skipped: the server's hub.env has no FIBER_ASSETS (the legacy asset variables), so the repo's whitelists are used as they are");
  } else {
    throw new RemoteCommandError(`${REGENERATE_WHITELISTS_COMMAND} in ${remoteDir} (the upload itself is done)`, result);
  }
}

/** Copies the uploaded templates into place (installTemplatesScript). */
async function installTemplates(ctx: DeployContext, overwrite: boolean): Promise<void> {
  await ctx.kit.run(installTemplatesScript(overwrite), { description: "put the fnn whitelists in place" });
}

/** The kit files of `names` the server does not have. */
async function missingKitFiles(ctx: DeployContext, names: readonly string[]): Promise<string[]> {
  const found = await Promise.all(names.map((name) => ctx.kit.fileExists(name)));
  return names.filter((_, index) => !found[index]);
}

/**
 * Whether the image Compose runs the hub from exists on the server. Without it, `docker compose run hub` (which
 * add_token.py uses) would build it unannounced, longer than the script waits.
 */
async function isHubImageBuilt(ctx: DeployContext): Promise<boolean> {
  const image = serviceImageOfConfig(await ctx.kit.compose(["config", "--format", "json"]), SERVICE.HUB);
  if (image === null) return false;
  const inspect = await ctx.kit.tryRun(`${shellJoin(["docker", "image", "inspect", image])} >/dev/null 2>&1`);
  return inspect.exitCode === 0 && !inspect.timedOut;
}
