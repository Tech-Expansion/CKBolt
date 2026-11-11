import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { after, describe, it } from "node:test";
import { parseEnv } from "node:util";
import { TESTNET_RUSD_TYPE_SCRIPT } from "../../src/common/constants/assets.constants";
import { loadHubConfig } from "../../src/config/hub.config";
import { BITCOIND_DATA_DIR, BITCOIND_VOLUME, COMPOSE_PROJECT } from "../scripts/lib/constants";
import { resolveDeployPaths } from "../scripts/lib/paths";
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

/** A copy of the kit with an .env and a hub.env, as the server has them after `testnet sync` and `testnet env`. */
function kitCopy(env: Record<string, string> = {}, hubEnv: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "deploy-kit-"));
  copies.push(dir);
  cpSync(KIT, dir, { recursive: true, filter: (source) => !/[\\/](\.env|hub\.env|secrets)$/.test(source) });
  writeFileSync(join(dir, ".env"), envText(exampleText, { ...VPS_ENV, ...env }));
  writeFileSync(join(dir, "hub.env"), envText(hubExampleText, hubEnv));
  return dir;
}

interface ComposePort {
  target: number;
  published?: string;
  host_ip?: string;
}
interface ComposeService {
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
    assert.deepEqual(networksOf(config.services.hub), ["default", "edge"]);
    assert.deepEqual(networksOf(config.services["fiber-ws"]), ["default", "edge"]);
    for (const node of ["fnn-hub", "lnd-hub", "bitcoind"]) assert.ok(!networksOf(config.services[node]).includes("edge"), node);
  });

  it("relays fiber-ws to fnn-hub's P2P port only, never its JSON-RPC", () => {
    const command = resolved({ COMPOSE_PROFILES: "tunnel", ...TOKEN }).services["fiber-ws"]?.command ?? [];
    assert.deepEqual(command, ["TCP-LISTEN:8228,fork,reuseaddr", "TCP:fnn-hub:8228"]);
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

  it("is accepted by the hub's loader with what docker-compose.yml adds", () => {
    const hub = loadHubConfig({
      ...example,
      QUOTE_SIGNING_KEY: QUOTE_KEY,
      DEMO_ENABLED: "false",
      LND_HOLD_EXPIRY_DELTA_BLOCKS: "18",
      FIBER_PUBLIC_WS_ADDRS: `/ip4/${PUBLIC_IP}/tcp/8228/ws`,
      FIBER_PUBLIC_P2P_ADDRS: `/ip4/${PUBLIC_IP}/tcp/8228`,
    });
    assert.equal(hub.pricing.maxSats, 20_000n);
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
