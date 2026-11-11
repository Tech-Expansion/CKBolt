import { parseArgs } from "node:util";
import type { DeployContext } from "../lib/context";
import { LND_SERVICES, type LndService } from "../lib/constants";
import { readFundingAddresses, showAddresses } from "../steps/addresses.step";
import { balanceLightning } from "../steps/balance.step";
import { openChannels } from "../steps/channels.step";
import { buildImages, downServices, passThroughCompose, showLogs, showStatus, upServices } from "../steps/compose.step";
import { completeKitEnv } from "../steps/env.step";
import { fund } from "../steps/fund.step";
import { handSteps } from "../steps/hand-steps";
import { installMacaroons } from "../steps/macaroons.step";
import { syncKit } from "../steps/sync.step";
import { createWallet } from "../steps/wallet.step";

/**
 * The commands of `npm --prefix deploy run testnet -- <command> [arguments]`. Every command can be run again and none
 * prints a secret. deploy/README.md is the runbook.
 */

export interface CommandArgs {
  positionals: string[];
  fresh: boolean;
  follow: boolean;
  tail: number | null;
}

export interface Command {
  usage: string;
  summary: string;
  run(ctx: DeployContext, args: CommandArgs): Promise<void>;
}

const COMPOSE_PASS_THROUGH = "compose";
const ARGUMENT_SEPARATOR = "--";
const HELP_WORDS: readonly string[] = ["help", "--help", "-h"];

export const COMMANDS: Readonly<Record<string, Command>> = {
  sync: {
    usage: "sync",
    summary: "upload the kit and the hub source (never .env, hub.env, secrets or data), then regenerate fnn's whitelists from hub.env",
    run: (ctx) => syncKit(ctx),
  },
  env: { usage: "env", summary: "create or complete .env, hub.env and the LND wallet passwords on the server", run: (ctx) => completeKitEnv(ctx) },
  build: { usage: "build [service...]", summary: "build the images on the server", run: (ctx, args) => buildImages(ctx, args.positionals) },
  up: {
    usage: "up [service...] [--fresh]",
    summary: "start services (guards: bitcoind keeps its chain volume, free ports, hub only once ready)",
    run: (ctx, args) => upServices(ctx, { services: args.positionals, fresh: args.fresh }),
  },
  down: {
    usage: "down [service...]",
    summary: "stop services; no service: the whole project (volumes are kept)",
    run: (ctx, args) => downServices(ctx, args.positionals),
  },
  status: { usage: "status", summary: "containers, health and published ports", run: (ctx) => showStatus(ctx) },
  logs: {
    usage: "logs [service...] [--tail N] [--follow]",
    summary: "the services' logs",
    run: (ctx, args) => showLogs(ctx, { services: args.positionals, lines: args.tail, follow: args.follow }),
  },
  wallet: {
    usage: "wallet <lnd-hub|lnd-demo>",
    summary: "create an LND wallet without a prompt; its seed stays on the server (secrets/wallet, mode 600)",
    run: (ctx, args) => createWallet(ctx, lndServiceOf(args.positionals[0])),
  },
  macaroons: { usage: "macaroons", summary: "bake the hub's least-privilege macaroons into secrets/hub", run: (ctx) => installMacaroons(ctx) },
  addresses: { usage: "addresses", summary: "the nodes' funding addresses", run: (ctx) => showAddresses(ctx) },
  fund: { usage: "fund", summary: "claim testnet CKB, fund lnd-demo from lnd-hub, print the hand steps", run: (ctx) => fund(ctx) },
  channels: {
    usage: "channels",
    summary: "open the Lightning and Fiber channels the hub needs (only what is missing)",
    run: (ctx) => openChannels(ctx),
  },
  balance: { usage: "balance", summary: "pay Mutinynet faucet invoices for inbound Lightning liquidity", run: (ctx) => balanceLightning(ctx) },
  steps: {
    usage: "steps",
    summary: "print the hand steps (faucet login, RUSD with JoyID)",
    run: async (ctx) => ctx.logger.raw(handSteps(ctx.settings, await readFundingAddresses(ctx)).join("\n")),
  },
};

export function lndServiceOf(value: string | undefined): LndService {
  const service = LND_SERVICES.find((candidate) => candidate === value);
  if (service) return service;
  throw new Error(`Name the LND node: ${LND_SERVICES.join(" or ")}`);
}

export function usage(): string {
  const passThrough = `${COMPOSE_PASS_THROUGH} ${ARGUMENT_SEPARATOR} <args>`;
  const width = Math.max(...Object.values(COMMANDS).map((command) => command.usage.length), passThrough.length);
  return [
    "Usage: npm --prefix deploy run testnet -- <command> [arguments]",
    "Server: DEPLOY_SSH_HOST and DEPLOY_REMOTE_DIR (deploy/deploy.env). Runbook: deploy/README.md",
    "",
    ...Object.values(COMMANDS).map((command) => `  ${command.usage.padEnd(width)}  ${command.summary}`),
    `  ${passThrough.padEnd(width)}  any docker compose command in the kit folder on the server`,
    "",
    "Also: npm --prefix deploy run testnet:check (readiness report), npm --prefix deploy run testnet:smoke (a real swap each way)",
  ].join("\n");
}

export function parseCommandArgs(args: readonly string[]): CommandArgs {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { fresh: { type: "boolean" }, follow: { type: "boolean" }, tail: { type: "string" } },
  });
  const tail = values.tail === undefined ? null : Number(values.tail);
  if (tail !== null && !(Number.isSafeInteger(tail) && tail >= 0)) throw new Error(`--tail must be a whole number (got "${values.tail}")`);
  return { positionals, fresh: values.fresh ?? false, follow: values.follow ?? false, tail };
}

/**
 * Runs one command line (without the program name) and returns the exit code. The context is built only for a known
 * command, so `help` and typos need no settings or server.
 */
export async function runTestnetCommand(
  argv: readonly string[],
  makeContext: () => DeployContext,
  print: (text: string) => void = console.log,
): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || HELP_WORDS.includes(name)) {
    print(usage());
    return 0;
  }
  if (name === COMPOSE_PASS_THROUGH) {
    await passThroughCompose(makeContext(), rest[0] === ARGUMENT_SEPARATOR ? rest.slice(1) : rest);
    return 0;
  }
  const command = COMMANDS[name];
  if (!command) {
    print(`Unknown command "${name}".\n\n${usage()}`);
    return 1;
  }
  const args = parseCommandArgs(rest);
  await command.run(makeContext(), args);
  return 0;
}
