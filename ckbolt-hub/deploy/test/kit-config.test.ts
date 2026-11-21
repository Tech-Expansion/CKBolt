import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { after, describe, it } from "node:test";
import { parseEnv } from "node:util";
import { TESTNET_RUSD_TYPE_SCRIPT } from "../../src/common/constants/assets.constants";
import { loadHubConfig } from "../../src/config/hub.config";
import { BITCOIND_DATA_DIR, BITCOIND_VOLUME, COMPOSE_PROJECT, KIT_SECRET_BYTES } from "../scripts/lib/constants";
import { envEntries, planEnvCompletion } from "../scripts/lib/env-file";
import { resolveDeployPaths } from "../scripts/lib/paths";
import { readableEnvKeys } from "../scripts/steps/env.step";
import { hasDockerCompose } from "./support/fakes";

/**
 * The kit itself: docker-compose.yml with docker-compose.public.yml, resolved by the real `docker compose config` on a
 * copy of deploy/testnet with the .env `testnet env` would leave on the VPS (from .env.example, secrets filled in), and
 * the hub's environment checked by the hub's own config loader. Static checks of the fnn configs and hub.env.example
 * need no Docker.
 */

const paths = resolveDeployPaths();
const KIT = paths.kitDir;
const NO_COMPOSE = !hasDockerCompose() && "Docker Compose is not installed";
const exampleText = readFileSync(join(KIT, ".env.example"), "utf8");
const hubExampleText = readFileSync(join(KIT, "hub.env.example"), "utf8");

const PUBLIC_IP = "203.0.113.7";
const QUOTE_KEY = "5e".repeat(32);
/** What the running Mutinynet sync's .env holds on the VPS; `testnet env` keeps it. */
const SYNC_USER = "syncuser";
const SYNC_PASSWORD = "sync-password-from-the-running-sync";
/** The .env `testnet env` leaves on the VPS: the example with every secret and PUBLIC_IP filled in. */
const VPS_ENV: Record<string, string> = {
  QUOTE_SIGNING_KEY: QUOTE_KEY,
  BITCOIND_RPC_USER: SYNC_USER,
  BITCOIND_RPC_PASSWORD: SYNC_PASSWORD,
  FNN_HUB_KEY_PASSWORD: "fnn-hub-key-password",
  FNN_DEMO_KEY_PASSWORD: "fnn-demo-key-password",
  PUBLIC_IP,
};
/**
 * What the operator fills in hub.env by hand (hub.env.example leaves it empty): the proxy secret, 64 hex characters as
 * `openssl rand -hex 32` makes. The hub listens on 0.0.0.0 in its container, so it refuses to start without it.
 */
const PROXY_SECRET = "a1".repeat(32);
const OPERATOR_HUB_ENV: Record<string, string> = { HUB_PROXY_SECRET: PROXY_SECRET };
/** The hub's refusal to start on a reachable HUB_HOST without HUB_PROXY_SECRET (security review H2). */
const NEEDS_PROXY_SECRET = /Invalid hub configuration: HUB_HOST \(0\.0\.0\.0\) lets other machines reach the hub, so it needs HUB_PROXY_SECRET/;

/** Ports the other projects on the VPS hold: the kit must never publish them. */
const OTHER_PROJECTS_PORTS = [80, 443, 3000, 8787, 6300, 5432];

/** The example file with `overrides` applied line by line (keys it lacks are appended). */
function envText(example: string, overrides: Record<string, string>): string {
  const seen = new Set<string>();
  const lines = example.split(/\r?\n/).map((line) => {
    const key = /^([A-Z0-9_]+)=/.exec(line)?.[1];
    if (key === undefined || !(key in overrides)) return line;
    seen.add(key);
    return `${key}=${overrides[key]}`;
  });
  for (const [key, value] of Object.entries(overrides)) if (!seen.has(key)) lines.push(`${key}=${value}`);
  return `${lines.join("\n")}\n`;
}

const copies: string[] = [];
after(() => {
  for (const dir of copies) rmSync(dir, { recursive: true, force: true });
});

/**
 * A copy of the kit with an .env and a hub.env, as the server has them after `testnet sync` and `testnet env` and the
 * operator has filled HUB_PROXY_SECRET in hub.env (a `hubEnv` entry replaces it, e.g. with "" for the bare example).
 */
function kitCopy(env: Record<string, string> = {}, hubEnv: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "deploy-kit-"));
  copies.push(dir);
  cpSync(KIT, dir, { recursive: true, filter: (source) => !/[\\/](\.env|hub\.env|secrets)$/.test(source) });
  writeFileSync(join(dir, ".env"), envText(exampleText, { ...VPS_ENV, ...env }));
  writeFileSync(join(dir, "hub.env"), envText(hubExampleText, { ...OPERATOR_HUB_ENV, ...hubEnv }));
  return dir;
}

interface ComposePort {
  target: number;
  published?: string;
  host_ip?: string;
}
interface ComposeService {
  image?: string;
  build?: { context: string; dockerfile?: string };
  logging?: { driver?: string; options?: Record<string, string> };
  security_opt?: string[];
  ports?: ComposePort[];
  environment?: Record<string, string | null>;
  command?: string[];
  volumes?: { type: string; source: string; target: string; read_only?: boolean }[];
  depends_on?: Record<string, { condition: string; required: boolean }>;
  profiles?: string[];
  /** As `docker compose config` writes it: a map by network name. */
  networks?: Record<string, unknown>;
}
interface ComposeConfig {
  name: string;
  services: Record<string, ComposeService>;
  configs: Record<string, { content: string }>;
  volumes: Record<string, { name: string }>;
  networks?: Record<string, { name?: string; external?: boolean; attachable?: boolean } | null>;
}

/** The variables of the kit's .env must come from the .env only: none of this machine's environment leaks in. */
function composeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COMPOSE_")) delete env[key];
  for (const key of Object.keys(parseEnv(exampleText))) delete env[key];
  // The kit's .env is written for the Linux server, where Compose splits COMPOSE_FILE on ":" (";" on Windows).
  env.COMPOSE_PATH_SEPARATOR = ":";
  return env;
}

function composeConfig(dir: string, args: string[] = []): { status: number | null; config: ComposeConfig | null; stderr: string } {
  const run = spawnSync("docker", ["compose", ...args, "config", "--format", "json"], {
    cwd: dir,
    encoding: "utf8",
    env: composeEnvironment(),
    timeout: 60_000,
    windowsHide: true,
  });
  return { status: run.status, config: run.status === 0 ? (JSON.parse(run.stdout) as ComposeConfig) : null, stderr: run.stderr };
}

function resolved(env: Record<string, string> = {}, hubEnv: Record<string, string> = {}, args: string[] = []): ComposeConfig {
  const run = composeConfig(kitCopy(env, hubEnv), args);
  assert.equal(run.status, 0, run.stderr);
  return run.config as ComposeConfig;
}

/** Every host port the config publishes: "<host_ip or *>:<port> -> <service>:<target>". */
function publishedPorts(config: ComposeConfig): string[] {
  return Object.entries(config.services).flatMap(([name, service]) =>
    (service.ports ?? []).map((port) => `${port.host_ip ?? "*"}:${port.published} -> ${name}:${port.target}`),
  );
}

const hubEnvironment = (config: ComposeConfig): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(config.services.hub?.environment ?? {}).map(([key, value]) => [key, value ?? undefined]));

describe("the kit on the VPS: docker-compose.yml + docker-compose.public.yml (docker compose config)", { skip: NO_COMPOSE }, () => {
  it("runs bitcoind, lnd-hub, fnn-hub and the hub in project ckbolt-testnet; the demo nodes stay out without the profile", () => {
    const config = resolved();
    assert.equal(config.name, COMPOSE_PROJECT);
    assert.deepEqual(Object.keys(config.services).sort(), ["bitcoind", "fnn-hub", "hub", "lnd-hub"]);
  });

  it("publishes only LND 9735 and fnn 8228 to the world and the hub on 127.0.0.1:18787: no RPC, none of the other projects' ports", () => {
    const config = resolved();
    assert.deepEqual(publishedPorts(config).sort(), ["*:8228 -> fnn-hub:8228", "*:9735 -> lnd-hub:9735", "127.0.0.1:18787 -> hub:8787"]);
    const hostPorts = Object.values(config.services).flatMap((service) => (service.ports ?? []).map((port) => Number(port.published)));
    for (const port of OTHER_PROJECTS_PORTS) assert.ok(!hostPorts.includes(port), `the kit publishes ${port}, which another project on the VPS holds`);
  });

  it("announces the public addresses: lnd-hub's external IP, fnn-hub's TCP and WebSocket addresses on the P2P port", () => {
    const config = resolved();
    assert.ok(config.services["lnd-hub"]?.command?.includes(`--externalip=${PUBLIC_IP}:9735`));
    const announced = (config.services["fnn-hub"]?.environment?.FIBER_ANNOUNCED_ADDRS ?? "").split(",");
    assert.deepEqual(announced, [`/ip4/${PUBLIC_IP}/tcp/8228`, `/ip4/${PUBLIC_IP}/tcp/8228/ws`]);
  });

  it("tells browsers where to dial through the hub: FIBER_PUBLIC_WS_ADDRS and FIBER_PUBLIC_P2P_ADDRS from PUBLIC_IP", () => {
    const env = resolved().services.hub?.environment ?? {};
    assert.equal(env.FIBER_PUBLIC_WS_ADDRS, `/ip4/${PUBLIC_IP}/tcp/8228/ws`);
    assert.equal(env.FIBER_PUBLIC_P2P_ADDRS, `/ip4/${PUBLIC_IP}/tcp/8228`);
  });

  it("follows the port settings everywhere they appear", () => {
    const config = resolved({ LND_HUB_P2P_PORT: "19735", FNN_HUB_P2P_PORT: "18228", HUB_HOST_PORT: "28787" });
    assert.deepEqual(publishedPorts(config).sort(), ["*:18228 -> fnn-hub:8228", "*:19735 -> lnd-hub:9735", "127.0.0.1:28787 -> hub:8787"]);
    assert.ok(config.services["lnd-hub"]?.command?.includes(`--externalip=${PUBLIC_IP}:19735`));
    assert.match(config.services["fnn-hub"]?.environment?.FIBER_ANNOUNCED_ADDRS ?? "", new RegExp(`/ip4/${PUBLIC_IP}/tcp/18228/ws`));
    assert.equal(config.services.hub?.environment?.FIBER_PUBLIC_WS_ADDRS, `/ip4/${PUBLIC_IP}/tcp/18228/ws`);
  });

  it("lets .env override what browsers dial (a full multiaddr with the peer id, or a future wss address)", () => {
    const ws = "/dns4/fiber.example.org/tcp/443/wss/p2p/QmHubPeerId1111111111111111111111111111111111";
    const p2p = `/ip4/${PUBLIC_IP}/tcp/8228/p2p/QmHubPeerId1111111111111111111111111111111111`;
    const config = resolved({ FIBER_PUBLIC_WS_ADDRS: ws, FIBER_PUBLIC_P2P_ADDRS: p2p });
    assert.equal(config.services.hub?.environment?.FIBER_PUBLIC_WS_ADDRS, ws);
    assert.equal(config.services.hub?.environment?.FIBER_PUBLIC_P2P_ADDRS, p2p);
    assert.deepEqual(loadHubConfig(hubEnvironment(config)).fiberPeers.publicAddresses, { ws: [ws], p2p: [p2p] });
  });

  it("keeps fnn-hub from accepting channels: CKB auto-accept 0 and the hub-only config without RUSD auto_accept_amount", () => {
    const fnnHub = resolved().services["fnn-hub"];
    assert.equal(fnnHub?.environment?.FIBER_AUTO_ACCEPT_CHANNEL_CKB_FUNDING_AMOUNT, "0");
    const mount = fnnHub?.volumes?.find((volume) => volume.target === "/etc/fnn/config.yml");
    assert.ok(mount?.source.endsWith(`fnn${sep}hub.yml`), mount?.source);
    assert.equal(mount?.read_only, true);
  });

  it("gives the hub a configuration its own loader accepts: signet, CKB testnet, Mutinynet timing, inbound channels, SWAP_MAX_SATS 20000", () => {
    const config = resolved();
    const env = config.services.hub?.environment ?? {};
    assert.equal(env.QUOTE_SIGNING_KEY, QUOTE_KEY);
    assert.equal(env.DEMO_ENABLED, "false");
    assert.equal(env.LND_HOLD_EXPIRY_DELTA_BLOCKS, "18");
    const hub = loadHubConfig(hubEnvironment(config));
    assert.equal(hub.bitcoin.network, "signet");
    assert.equal(hub.ckb.network, "testnet");
    assert.equal(hub.pricing.maxSats, 20_000n);
    assert.equal(hub.pricing.signingKeyHex, QUOTE_KEY);
    assert.equal(hub.timing.lndHoldExpiryDeltaBlocks, 18);
    assert.equal(hub.server.trustProxy, false, "one client through the SSH tunnel");
    assert.equal(hub.server.proxySecret, PROXY_SECRET, "hub.env's secret reaches the hub");
    assert.equal(hub.server.port, 8787);
    assert.equal(hub.demo.enabled, false);
    assert.deepEqual(hub.fiberPeers.inboundChannels.amounts, { CKB: 200_000_000_000n });
    assert.equal(hub.fiberPeers.inboundChannels.enabled, true);
    assert.equal(hub.lnd.grpcHost, "lnd-hub:10009");
    assert.equal(hub.fiber.rpcUrl, "http://fnn-hub:8227");
  });

  it("feeds LND_HOLD_EXPIRY_DELTA_BLOCKS to LND's invoices.holdexpirydelta and to the hub together", () => {
    const config = resolved({ LND_HOLD_EXPIRY_DELTA_BLOCKS: "40" });
    assert.match(config.configs["lnd-conf"]?.content ?? "", /^invoices\.holdexpirydelta=40$/m);
    assert.equal(config.services.hub?.environment?.LND_HOLD_EXPIRY_DELTA_BLOCKS, "40");
    assert.equal(loadHubConfig(hubEnvironment(config)).timing.lndHoldExpiryDeltaBlocks, 40);
    assert.match(resolved().configs["lnd-conf"]?.content ?? "", /^invoices\.holdexpirydelta=18$/m);
  });

  it("takes over the running sync: volume ckbolt-testnet_bitcoind at /data, and the sync's RPC credentials in bitcoind and both LND", () => {
    const config = resolved({ BITCOIND_DBCACHE_MB: "1000" });
    assert.equal(config.volumes.bitcoind?.name, BITCOIND_VOLUME);
    const data = config.services.bitcoind?.volumes?.find((volume) => volume.source === "bitcoind");
    assert.equal(data?.target, BITCOIND_DATA_DIR);
    const bitcoinConf = config.configs["bitcoin-conf"]?.content ?? "";
    assert.match(bitcoinConf, new RegExp(`^rpcuser=${SYNC_USER}$`, "m"));
    assert.match(bitcoinConf, new RegExp(`^rpcpassword=${SYNC_PASSWORD}$`, "m"));
    assert.match(bitcoinConf, /^dbcache=1000$/m);
    assert.match(bitcoinConf, /^signetchallenge=512102f7561d208dd9ae99bf497273e16f389bdbd6c4742ddb8e6b216e64fa2928ad8f51ae$/m, "Mutinynet");
    const lndConf = config.configs["lnd-conf"]?.content ?? "";
    assert.match(lndConf, new RegExp(`^bitcoind\\.rpcuser=${SYNC_USER}$`, "m"));
    assert.match(lndConf, new RegExp(`^bitcoind\\.rpcpass=${SYNC_PASSWORD}$`, "m"));
    assert.match(lndConf, /^bitcoin\.signet=true$/m);
    assert.doesNotMatch(lndConf, /signetchallenge/, "LND must not set a signet challenge with bitcoind (research 2.1)");
    assert.doesNotMatch(lndConf, /bitcoin\.mainnet|bitcoin\.testnet/);
  });

  it("keeps LND's REST and RPC and bitcoind's RPC off the host (REST only on the container's loopback)", () => {
    const config = resolved();
    assert.match(config.configs["lnd-conf"]?.content ?? "", /^restlisten=127\.0\.0\.1:8080$/m);
    for (const name of ["bitcoind", "lnd-hub"]) {
      const ports = (config.services[name]?.ports ?? []).map((port) => port.target);
      assert.ok(!ports.some((port) => [8080, 10009, 38332, 28332, 28333].includes(port)), `${name} publishes an RPC port`);
    }
  });

  it("gives the hub a configuration its loader refuses while hub.env's HUB_PROXY_SECRET is still empty, as in the example", () => {
    const config = resolved({}, { HUB_PROXY_SECRET: "" });
    assert.equal(config.services.hub?.environment?.HUB_PROXY_SECRET, "");
    assert.throws(() => loadHubConfig(hubEnvironment(config)), NEEDS_PROXY_SECRET);
  });

  it("refuses to start without QUOTE_SIGNING_KEY", () => {
    const run = composeConfig(kitCopy({ QUOTE_SIGNING_KEY: "" }));
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /QUOTE_SIGNING_KEY/);
  });

  it("refuses the public overlay without PUBLIC_IP, with the message saying where to set it", () => {
    const run = composeConfig(kitCopy({ PUBLIC_IP: "" }));
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /set PUBLIC_IP in deploy\/testnet\/\.env/);
  });

  it("refuses a missing bitcoind or fnn password instead of starting with an empty one", () => {
    for (const key of ["BITCOIND_RPC_PASSWORD", "FNN_HUB_KEY_PASSWORD"]) {
      const run = composeConfig(kitCopy({ [key]: "" }));
      assert.notEqual(run.status, 0, key);
      assert.match(run.stderr, new RegExp(key));
    }
  });
});

describe("the kit without a public address (docker-compose.yml alone)", { skip: NO_COMPOSE }, () => {
  it("validates without PUBLIC_IP and publishes nothing but the hub on 127.0.0.1", () => {
    const config = resolved({ COMPOSE_FILE: "docker-compose.yml", PUBLIC_IP: "" });
    assert.deepEqual(publishedPorts(config), ["127.0.0.1:18787 -> hub:8787"]);
    assert.ok(!config.services["lnd-hub"]?.command?.some((flag) => flag.startsWith("--externalip")));
    assert.equal(config.services["fnn-hub"]?.environment?.FIBER_ANNOUNCED_ADDRS, "/dns4/fnn-hub/tcp/8228");
  });

  it("is what `docker compose -f docker-compose.yml config` resolves too (the explicit file wins over COMPOSE_FILE)", () => {
    const config = resolved({}, {}, ["-f", "docker-compose.yml"]);
    assert.deepEqual(publishedPorts(config), ["127.0.0.1:18787 -> hub:8787"]);
  });

  it("needs FIBER_INBOUND_ENABLED=false there: the hub's loader says why otherwise", () => {
    const config = resolved({ COMPOSE_FILE: "docker-compose.yml", PUBLIC_IP: "" });
    assert.throws(() => loadHubConfig(hubEnvironment(config)), /FIBER_INBOUND_ENABLED needs FIBER_PUBLIC_WS_ADDRS or FIBER_PUBLIC_P2P_ADDRS/);
    const without = resolved({ COMPOSE_FILE: "docker-compose.yml", PUBLIC_IP: "" }, { FIBER_INBOUND_ENABLED: "false" });
    assert.equal(loadHubConfig(hubEnvironment(without)).fiberPeers.inboundChannels.enabled, false);
  });
});

describe("the tunnel profile (Cloudflare Tunnel: cloudflared and fiber-ws)", { skip: NO_COMPOSE }, () => {
  const TOKEN = { CLOUDFLARED_TUNNEL_TOKEN: "tunnel-token-from-cloudflare" };
  const networksOf = (service: ComposeService | undefined): string[] => Object.keys(service?.networks ?? {}).sort();

  it("stays out without the profile: no cloudflared, no fiber-ws", () => {
    const services = Object.keys(resolved().services);
    assert.ok(!services.includes("cloudflared") && !services.includes("fiber-ws"), services.join(", "));
  });

  it("adds cloudflared and fiber-ws, publishing nothing: the tunnel only dials out", () => {
    const config = resolved({ COMPOSE_PROFILES: "tunnel", ...TOKEN });
    assert.deepEqual(Object.keys(config.services).sort(), ["bitcoind", "cloudflared", "fiber-ws", "fnn-hub", "hub", "lnd-hub"]);
    assert.deepEqual(config.services.cloudflared?.ports ?? [], []);
    assert.deepEqual(config.services["fiber-ws"]?.ports ?? [], []);
    assert.equal(config.services.cloudflared?.environment?.TUNNEL_TOKEN, TOKEN.CLOUDFLARED_TUNNEL_TOKEN);
    assert.deepEqual(config.services.cloudflared?.command, ["tunnel", "run"]);
  });

  it("puts cloudflared on the edge network only, with the hub and fiber-ws: it cannot reach a node's RPC", () => {
    const config = resolved({ COMPOSE_PROFILES: "tunnel", ...TOKEN });
    assert.deepEqual(networksOf(config.services.cloudflared), ["edge"]);
    // The hub also joins `bitcoin`, where its LND nodes are (security review D1).
    assert.deepEqual(networksOf(config.services.hub), ["bitcoin", "default", "edge"]);
    assert.deepEqual(networksOf(config.services["fiber-ws"]), ["default", "edge"]);
    for (const node of ["fnn-hub", "lnd-hub", "bitcoind"]) assert.ok(!networksOf(config.services[node]).includes("edge"), node);
  });

  it("relays fiber-ws to fnn-hub's P2P port only, never its JSON-RPC", () => {
    const command = resolved({ COMPOSE_PROFILES: "tunnel", ...TOKEN }).services["fiber-ws"]?.command ?? [];
    // At most FIBER_WS_MAX_CHILDREN (200 in .env.example) relays at once (security review D7).
    assert.deepEqual(command, ["TCP-LISTEN:8228,fork,reuseaddr,max-children=200", "TCP:fnn-hub:8228"]);
  });

  it("publishes the same host ports with and without the tunnel", () => {
    const vps = { COMPOSE_FILE: "docker-compose.yml:docker-compose.public.yml", PUBLIC_IP: PUBLIC_IP };
    assert.deepEqual(publishedPorts(resolved({ ...vps, COMPOSE_PROFILES: "tunnel", ...TOKEN })).sort(), publishedPorts(resolved(vps)).sort());
  });
});

describe("the demo profile", { skip: NO_COMPOSE }, () => {
  it("adds lnd-demo and fnn-demo, publishing nothing, with fnn-demo on its own config", () => {
    const config = resolved({ COMPOSE_PROFILES: "demo" });
    assert.deepEqual(Object.keys(config.services).sort(), ["bitcoind", "fnn-demo", "fnn-hub", "hub", "lnd-demo", "lnd-hub"]);
    assert.deepEqual(config.services["lnd-demo"]?.ports ?? [], []);
    assert.deepEqual(config.services["fnn-demo"]?.ports ?? [], []);
    const mount = config.services["fnn-demo"]?.volumes?.find((volume) => volume.target === "/etc/fnn/config.yml");
    assert.ok(mount?.source.endsWith(`fnn${sep}demo.yml`), mount?.source);
    assert.equal(config.services["fnn-demo"]?.environment?.FIBER_AUTO_ACCEPT_CHANNEL_CKB_FUNDING_AMOUNT, undefined, "fnn-demo accepts the hub's channels");
  });

  it("makes the hub wait for the demo nodes only when they run (depends_on required: false)", () => {
    const dependsOn = resolved().services.hub?.depends_on ?? {};
    assert.equal(dependsOn["lnd-hub"]?.required, true);
    assert.equal(dependsOn["fnn-hub"]?.required, true);
    assert.equal(dependsOn["lnd-demo"]?.required, false);
    assert.equal(dependsOn["fnn-demo"]?.required, false);
  });

  it("gives the hub a demo configuration its loader accepts with DEMO_ENABLED=true", () => {
    const config = resolved({ COMPOSE_PROFILES: "demo", DEMO_ENABLED: "true" });
    const hub = loadHubConfig(hubEnvironment(config));
    assert.equal(hub.demo.enabled, true);
    assert.equal(hub.demo.lnd?.grpcHost, "lnd-demo:10009");
    assert.equal(hub.demo.fiber?.rpcUrl, "http://fnn-demo:8227");
  });
});

/* ------------------------------------------------------------------------- security review, round 2 (D1, D7, D8) */

/** Every profile on: all eight services. */
const ALL_PROFILES = { COMPOSE_PROFILES: "demo,tunnel", DEMO_ENABLED: "true", CLOUDFLARED_TUNNEL_TOKEN: "tunnel-token-from-cloudflare" };
const ALL_SERVICES = ["bitcoind", "cloudflared", "fiber-ws", "fnn-demo", "fnn-hub", "hub", "lnd-demo", "lnd-hub"];
/** The kit as the VPS runs it, with no profile, with every profile, and without the public overlay. */
const KIT_VARIANTS: [string, Record<string, string>][] = [
  ["no profile", {}],
  ["demo and tunnel profiles", ALL_PROFILES],
  ["docker-compose.yml alone, every profile", { ...ALL_PROFILES, COMPOSE_FILE: "docker-compose.yml", PUBLIC_IP: "" }],
];
const exampleEnv = parseEnv(exampleText) as Record<string, string>;
const composeText = readFileSync(join(KIT, "docker-compose.yml"), "utf8");

/** The services on each network, sorted: { network: [service, ...] }. */
function networkMembers(config: ComposeConfig): Record<string, string[]> {
  const members: Record<string, string[]> = {};
  for (const [service, definition] of Object.entries(config.services)) {
    for (const network of Object.keys(definition.networks ?? {})) (members[network] ??= []).push(service);
  }
  for (const list of Object.values(members)) list.sort();
  return members;
}

describe("D1: bitcoind and LND on a network of their own, `bitcoin` (docker compose config)", { skip: NO_COMPOSE }, () => {
  it("has exactly bitcoind, both LND nodes and the hub on it, with every profile on", () => {
    const config = resolved(ALL_PROFILES);
    assert.deepEqual(Object.keys(config.services).sort(), ALL_SERVICES);
    assert.deepEqual(networkMembers(config).bitcoin, ["bitcoind", "hub", "lnd-demo", "lnd-hub"]);
  });

  for (const [variant, env] of KIT_VARIANTS) {
    it(`keeps fnn-hub, fnn-demo, fiber-ws and cloudflared off it (${variant})`, () => {
      const members = networkMembers(resolved(env));
      for (const service of ["fnn-hub", "fnn-demo", "fiber-ws", "cloudflared"]) assert.ok(!(members.bitcoin ?? []).includes(service), service);
      assert.ok((members.bitcoin ?? []).includes("hub"), "the hub reaches its LND there");
      assert.ok((members.bitcoin ?? []).every((service) => ["bitcoind", "hub", "lnd-demo", "lnd-hub"].includes(service)), members.bitcoin?.join(", "));
    });
  }

  it("puts bitcoind and the LND nodes on `bitcoin` only: not on default (fnn, fiber-ws), not on edge (the tunnel)", () => {
    const config = resolved(ALL_PROFILES);
    for (const service of ["bitcoind", "lnd-hub", "lnd-demo"]) assert.deepEqual(Object.keys(config.services[service]?.networks ?? {}), ["bitcoin"], service);
  });

  it("leaves the edge network as it was: cloudflared, fiber-ws and the hub; and default to the Fiber side", () => {
    const members = networkMembers(resolved(ALL_PROFILES));
    assert.deepEqual(members.edge, ["cloudflared", "fiber-ws", "hub"]);
    assert.deepEqual(members.default, ["fiber-ws", "fnn-demo", "fnn-hub", "hub"]);
  });

  it("is the project's own network (ckbolt-testnet_bitcoin), not an external one another project such as the faucet could share", () => {
    const network = resolved(ALL_PROFILES).networks?.bitcoin;
    assert.equal(network?.name, `${COMPOSE_PROJECT}_bitcoin`);
    assert.ok(!network?.external, "not external");
    assert.ok(!network?.attachable, "not attachable");
    assert.doesNotMatch(composeText, /^\s+faucet:/m, "the faucet is not a service of this kit");
  });

  it("still lets every node reach what it talks to: the hub its LND and fnn, LND bitcoind, fnn-demo fnn-hub", () => {
    const config = resolved(ALL_PROFILES);
    const shared = (a: string, b: string): string[] =>
      Object.keys(config.services[a]?.networks ?? {}).filter((network) => network in (config.services[b]?.networks ?? {}));
    for (const [a, b] of [["hub", "lnd-hub"], ["hub", "lnd-demo"], ["hub", "fnn-hub"], ["hub", "fnn-demo"], ["lnd-hub", "bitcoind"], ["lnd-demo", "bitcoind"], ["lnd-demo", "lnd-hub"], ["fnn-demo", "fnn-hub"], ["fiber-ws", "fnn-hub"], ["cloudflared", "hub"], ["cloudflared", "fiber-ws"]] as const) {
      assert.ok(shared(a, b).length > 0, `${a} and ${b} share no network`);
    }
    const hub = loadHubConfig(hubEnvironment(config));
    assert.equal(hub.lnd.grpcHost, "lnd-hub:10009");
    assert.match(config.configs["lnd-conf"]?.content ?? "", /^bitcoind\.rpchost=bitcoind:38332$/m);
  });
});

describe("D7: log rotation and no-new-privileges on every service (docker compose config)", { skip: NO_COMPOSE }, () => {
  for (const [variant, env] of KIT_VARIANTS) {
    it(`rotates every service's json-file log at 10m, keeping 5 files, and sets no-new-privileges (${variant})`, () => {
      const config = resolved(env);
      for (const [name, service] of Object.entries(config.services)) {
        assert.deepEqual(service.logging, { driver: "json-file", options: { "max-size": "10m", "max-file": "5" } }, name);
        assert.ok(service.security_opt?.includes("no-new-privileges:true"), `${name}: ${service.security_opt?.join(", ")}`);
      }
    });
  }

  it("takes LOG_MAX_SIZE and LOG_MAX_FILES from .env for every service", () => {
    const config = resolved({ ...ALL_PROFILES, LOG_MAX_SIZE: "50m", LOG_MAX_FILES: "3" });
    for (const [name, service] of Object.entries(config.services)) assert.deepEqual(service.logging?.options, { "max-size": "50m", "max-file": "3" }, name);
  });

  it("caps fiber-ws's relays at FIBER_WS_MAX_CHILDREN, 200 unless .env says otherwise", () => {
    const command = (env: Record<string, string>) => resolved({ ...ALL_PROFILES, ...env }).services["fiber-ws"]?.command ?? [];
    assert.deepEqual(command({}), ["TCP-LISTEN:8228,fork,reuseaddr,max-children=200", "TCP:fnn-hub:8228"]);
    assert.deepEqual(command({ FIBER_WS_MAX_CHILDREN: "50" }), ["TCP-LISTEN:8228,fork,reuseaddr,max-children=50", "TCP:fnn-hub:8228"]);
  });

  it("documents the defaults in .env.example, equal to the compose file's own", () => {
    assert.equal(exampleEnv.LOG_MAX_SIZE, "10m");
    assert.equal(exampleEnv.LOG_MAX_FILES, "5");
    assert.equal(exampleEnv.FIBER_WS_MAX_CHILDREN, "200");
    assert.match(composeText, /max-size: \$\{LOG_MAX_SIZE:-10m\}/);
    assert.match(composeText, /max-file: "\$\{LOG_MAX_FILES:-5\}"/);
    assert.match(composeText, /max-children=\$\{FIBER_WS_MAX_CHILDREN:-200\}/);
  });

  it("applies the same defaults when the server's .env predates these keys", () => {
    const withoutKeys = Object.fromEntries(Object.keys(exampleEnv).filter((key) => /^(LOG_MAX_|FIBER_WS_MAX_CHILDREN)/.test(key)).map((key) => [key, ""]));
    // An empty value: Compose's `:-` default applies as for a missing key.
    const config = resolved({ ...ALL_PROFILES, ...withoutKeys });
    for (const [name, service] of Object.entries(config.services)) assert.deepEqual(service.logging?.options, { "max-size": "10m", "max-file": "5" }, name);
    assert.ok(config.services["fiber-ws"]?.command?.[0]?.endsWith("max-children=200"));
  });
});

/** An image pinned by tag and digest: name:tag@sha256:<64 hex>. */
const PINNED_IMAGE = /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*@sha256:[0-9a-f]{64}$/;
const DIGEST_KEYS = ["LND_DIGEST", "CLOUDFLARED_DIGEST", "SOCAT_DIGEST"];

describe("D8: third-party images pinned by digest", () => {
  it("names a sha256 digest for each third-party image in .env.example, next to its version", () => {
    for (const key of DIGEST_KEYS) {
      assert.match(exampleEnv[key] ?? "", /^sha256:[0-9a-f]{64}$/, key);
      assert.ok(exampleEnv[key.replace("_DIGEST", "_VERSION")], `${key.replace("_DIGEST", "_VERSION")} is next to it`);
    }
  });

  it("uses the same digests as the compose file's defaults, so a server .env without them runs the same images", () => {
    const defaults = Object.fromEntries([...composeText.matchAll(/\$\{([A-Z_]+_DIGEST):-(sha256:[0-9a-f]{64})\}/g)].map((match) => [match[1], match[2]]));
    assert.deepEqual(Object.keys(defaults).sort(), [...DIGEST_KEYS].sort());
    for (const key of DIGEST_KEYS) assert.equal(defaults[key], exampleEnv[key], key);
  });

  it("reaches a server .env that predates it: `testnet env` adds the digests and the D7 settings with the example's values", () => {
    const newKeys = [...DIGEST_KEYS, "FIBER_WS_MAX_CHILDREN", "LOG_MAX_SIZE", "LOG_MAX_FILES"];
    const readable = readableEnvKeys(exampleText);
    for (const key of newKeys) assert.ok(readable.includes(key), `${key} is not a secret: the scripts may read it back`);
    const older = new Map(
      [...envEntries(exampleText)].filter(([key]) => !newKeys.includes(key)).map(([key, value]) => [key, { set: true, value: readable.includes(key) ? value || "x" : null }]),
    );
    const plan = planEnvCompletion({ exampleText, probe: older, secretBytes: KIT_SECRET_BYTES, publicIp: PUBLIC_IP });
    assert.deepEqual(
      plan.fills.sort((a, b) => a.key.localeCompare(b.key)),
      newKeys.map((key) => ({ key, kind: "value", value: exampleEnv[key] })).sort((a, b) => a.key.localeCompare(b.key)),
    );
  });

  it("pins the bitcoind and fnn base image and the hub's node image by tag and digest, and builds only from them", () => {
    const dockerfiles = [join(KIT, "bitcoind", "Dockerfile"), join(paths.hubRoot, "devnet", "fnn", "Dockerfile"), join(KIT, "hub", "Dockerfile")];
    for (const file of dockerfiles) {
      const text = readFileSync(file, "utf8");
      const args = new Map([...text.matchAll(/^ARG ([A-Z_]+IMAGE)=(\S+)$/gm)].map((match) => [match[1] ?? "", match[2] ?? ""]));
      assert.ok(args.size > 0, `${file}: no base image ARG`);
      for (const [name, image] of args) assert.match(image, PINNED_IMAGE, `${file}: ${name}`);
      const froms = [...text.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1] ?? "");
      assert.ok(froms.length > 0, file);
      for (const from of froms) assert.match(from, /^\$\{[A-Z_]+IMAGE\}$/, `${file}: FROM ${from} is not the pinned ARG`);
    }
  });
});

describe("D8: the images the kit runs (docker compose config)", { skip: NO_COMPOSE }, () => {
  it("runs every image it does not build by tag and digest: LND, cloudflared and socat", () => {
    const config = resolved(ALL_PROFILES);
    const pulled = Object.entries(config.services).filter(([, service]) => !service.build && !service.image?.startsWith("ckbolt/"));
    assert.deepEqual(pulled.map(([name]) => name).sort(), ["cloudflared", "fiber-ws", "lnd-demo", "lnd-hub"]);
    for (const [name, service] of pulled) assert.match(service.image ?? "", PINNED_IMAGE, name);
    assert.equal(config.services["lnd-hub"]?.image, `lightninglabs/lnd:${exampleEnv.LND_VERSION}@${exampleEnv.LND_DIGEST}`);
    assert.equal(config.services.cloudflared?.image, `cloudflare/cloudflared:${exampleEnv.CLOUDFLARED_VERSION}@${exampleEnv.CLOUDFLARED_DIGEST}`);
    assert.equal(config.services["fiber-ws"]?.image, `alpine/socat:${exampleEnv.SOCAT_VERSION}@${exampleEnv.SOCAT_DIGEST}`);
  });

  it("builds its own images (bitcoind, fnn-hub, the hub) from Dockerfiles whose base images are pinned; fnn-demo reuses fnn-hub's", () => {
    const config = resolved(ALL_PROFILES);
    const built = Object.entries(config.services).filter(([, service]) => service.build);
    assert.deepEqual(built.map(([name]) => name).sort(), ["bitcoind", "fnn-hub", "hub"]);
    assert.equal(config.services["fnn-demo"]?.image, config.services["fnn-hub"]?.image);
    assert.ok(!config.services["fnn-demo"]?.build, "fnn-demo never builds or pulls");
  });

  it("follows a digest set in .env: the digest decides what runs", () => {
    const other = `sha256:${"ab".repeat(32)}`;
    const config = resolved({ ...ALL_PROFILES, LND_DIGEST: other, SOCAT_DIGEST: other, CLOUDFLARED_DIGEST: other });
    for (const name of ["lnd-hub", "lnd-demo", "fiber-ws", "cloudflared"]) assert.ok(config.services[name]?.image?.endsWith(`@${other}`), name);
  });

  it("falls back to the compose file's pinned digest when the server's .env has no digest yet", () => {
    const config = resolved({ ...ALL_PROFILES, LND_DIGEST: "", SOCAT_DIGEST: "", CLOUDFLARED_DIGEST: "" });
    assert.equal(config.services["lnd-hub"]?.image, `lightninglabs/lnd:${exampleEnv.LND_VERSION}@${exampleEnv.LND_DIGEST}`);
    for (const name of ["lnd-hub", "lnd-demo", "fiber-ws", "cloudflared"]) assert.match(config.services[name]?.image ?? "", PINNED_IMAGE, name);
  });
});

/* ------------------------------------------------------------------------------------------ static checks */

/** The env variable names the hub's config schema reads (src/config/hub.config.ts, envSchema). */
function hubSchemaKeys(): Set<string> {
  const source = readFileSync(join(paths.hubRoot, "src", "config", "hub.config.ts"), "utf8");
  const start = source.indexOf("const envSchema = z.object({");
  const end = source.indexOf("\n});", start);
  assert.ok(start >= 0 && end > start, "envSchema not found in hub.config.ts");
  return new Set([...source.slice(start, end).matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1] ?? ""));
}

describe("hub.env.example", () => {
  const example = parseEnv(hubExampleText) as Record<string, string>;

  it("names only variables the hub reads (a typo would be ignored silently)", () => {
    const schema = hubSchemaKeys();
    assert.ok(schema.size > 40, "the schema was read");
    assert.deepEqual(Object.keys(example).filter((key) => !schema.has(key)), []);
  });

  it("runs on Mutinynet and CKB testnet, never mainnet", () => {
    assert.equal(example.BTC_NETWORK, "signet");
    assert.equal(example.TIMING_PROFILE, "mutinynet");
    assert.equal(example.CKB_NETWORK, "testnet");
    assert.doesNotMatch(hubExampleText, /^[A-Z_]+=.*mainnet/m);
  });

  it("starts small and behind the tunnel: SWAP_MAX_SATS 20000, HUB_TRUST_PROXY false, no CORS origin", () => {
    assert.equal(example.SWAP_MAX_SATS, "20000");
    assert.equal(example.HUB_TRUST_PROXY, "false");
    assert.equal(example.HUB_CORS_ORIGINS, "");
  });

  it("configures inbound channels for browser Fiber nodes with the hub's FIBER_INBOUND_* names", () => {
    for (const key of ["FIBER_INBOUND_ENABLED", "FIBER_INBOUND_CKB_AMOUNT", "FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY", "FIBER_INBOUND_MAX_PER_NODE_PER_DAY", "FIBER_INBOUND_MAX_OPEN"]) {
      assert.ok(key in example, key);
    }
    assert.match(hubExampleText, /^# FIBER_INBOUND_RUSD_AMOUNT=/m, "RUSD stays commented out: an empty value is refused by the hub");
  });

  it("leaves to docker-compose.yml what must be one value: the signing key, the demo switch, the hold delta and the public addresses", () => {
    for (const key of ["QUOTE_SIGNING_KEY", "DEMO_ENABLED", "LND_HOLD_EXPIRY_DELTA_BLOCKS", "FIBER_PUBLIC_WS_ADDRS", "FIBER_PUBLIC_P2P_ADDRS"]) {
      assert.ok(!(key in example), `${key} belongs in .env (docker-compose.yml passes it), not hub.env`);
    }
  });

  /** What docker-compose.yml adds to hub.env for the hub. */
  const COMPOSE_ADDS = {
    QUOTE_SIGNING_KEY: QUOTE_KEY,
    DEMO_ENABLED: "false",
    LND_HOLD_EXPIRY_DELTA_BLOCKS: "18",
    FIBER_PUBLIC_WS_ADDRS: `/ip4/${PUBLIC_IP}/tcp/8228/ws`,
    FIBER_PUBLIC_P2P_ADDRS: `/ip4/${PUBLIC_IP}/tcp/8228`,
  };

  it("names HUB_PROXY_SECRET for the operator to fill, and leaves it empty: a secret never goes in the repository", () => {
    assert.equal(example.HUB_PROXY_SECRET, "");
    assert.equal(example.HUB_HOST, "0.0.0.0");
  });

  it("is accepted by the hub's loader with what docker-compose.yml adds and the secret the operator fills", () => {
    const hub = loadHubConfig({ ...example, ...COMPOSE_ADDS, ...OPERATOR_HUB_ENV });
    assert.equal(hub.pricing.maxSats, 20_000n);
    assert.equal(hub.server.proxySecret, PROXY_SECRET);
  });

  it("is refused by the hub's loader as it stands, with only what docker-compose.yml adds: HUB_PROXY_SECRET is empty", () => {
    assert.throws(() => loadHubConfig({ ...example, ...COMPOSE_ADDS }), NEEDS_PROXY_SECRET);
  });
});

describe("the fnn configs", () => {
  const hubYml = readFileSync(join(KIT, "fnn", "hub.yml"), "utf8");
  const demoYml = readFileSync(join(KIT, "fnn", "demo.yml"), "utf8");
  /** The YAML without comments and blank lines. */
  const body = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+#.*$/, ""))
      .filter((line) => line.trim() && !line.trim().startsWith("#"));

  it("fnn-hub accepts no RUSD channel: hub.yml has no auto_accept_amount", () => {
    assert.doesNotMatch(hubYml, /^\s*auto_accept_amount:/m);
  });

  it("fnn-demo keeps the RUSD auto-accept of fnn's bundled testnet config (10 RUSD)", () => {
    assert.match(demoYml, /^\s+auto_accept_amount: 1000000000$/m);
  });

  it("are the same file apart from that line, so they stay in step", () => {
    const demoBody = body(demoYml).filter((line) => !/auto_accept_amount:/.test(line));
    assert.deepEqual(body(hubYml), demoBody);
  });

  it("run on CKB testnet with the pubsub module the hub listens to, and RUSD's testnet script (args anchored: fnn reads them as a regex)", () => {
    assert.match(hubYml, /^\s+chain: testnet$/m);
    assert.match(hubYml, /^\s+- pubsub$/m);
    assert.ok(hubYml.includes(`code_hash: ${TESTNET_RUSD_TYPE_SCRIPT.codeHash}`));
    assert.ok(hubYml.includes(`args: "^${TESTNET_RUSD_TYPE_SCRIPT.args}$"`));
    assert.doesNotMatch(hubYml, /chain: mainnet/);
  });
});

describe("no hard-coded server", () => {
  /** Every file of the kit and the scripts (the runbook may name the VPS: it is the operator's guide). */
  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
  }

  it("names no host or IP of the VPS in the scripts, the kit or the settings example: DEPLOY_SSH_HOST and PUBLIC_IP come from settings", () => {
    const sources = [...files(join(paths.deployDir, "scripts")), ...files(KIT), join(paths.deployDir, "deploy.env.example"), join(paths.deployDir, "package.json")];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /testnet-vps|173\.212\.202\.229/, relative(paths.deployDir, file));
    }
  });
});
