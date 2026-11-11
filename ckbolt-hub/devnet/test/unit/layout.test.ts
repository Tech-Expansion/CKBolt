import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CONTAINER_PORT, SERVICE } from "../../scripts/lib/devnet.constants";
import { resolveDevnetPaths } from "../../scripts/lib/paths";

/**
 * Static checks of the devnet files against the module spec (docs/phase-3-plan.md section 4 versions, the devnet task):
 * pinned images, ports on 127.0.0.1 only, Fiber v0.9.1 contracts byte for byte, LF endings, ignored secrets.
 * The compose checks read `docker compose config` (the Docker CLI only; no running stack needed).
 */
const devnetDir = resolveDevnetPaths().devnetDir;
const read = (relative: string): string => readFileSync(join(devnetDir, relative), "utf8");

/** SHA-256 of tests/deploy/contracts/* at github.com/nervosnetwork/fiber tag v0.9.1 (downloaded and hashed). */
const FIBER_V091_CONTRACT_SHA256: Record<string, string> = {
  auth: "51d06e5c5b088424c51a6205eeede1a33054fd752a101cad0d545f32e01da33d",
  "funding-lock": "f87a7287e17a6ef828686129c143a79e8651b275e884edacbaa718590c227c96",
  "commitment-lock": "e3686a0ae96a208365741fa127ab8a8a4f283372d14f8da3fbebd34d090573db",
  simple_udt: "b1a962cb43d88e777d9df0aa4e67270ee758d9abdd18b1c56b106a5eed149af9",
  xudt_rce: "e9b92e5783f692f6ee99ca20eeda5f3da282e0f4010eb4fbd3db4e3058239349",
};

interface ComposePort {
  host_ip?: string;
  target: number;
  published?: string;
}
interface ComposeService {
  image?: string;
  build?: unknown;
  ports?: ComposePort[];
  environment?: Record<string, string>;
  restart?: string;
  healthcheck?: unknown;
}

function composeConfig(env: NodeJS.ProcessEnv = process.env): { services: Record<string, ComposeService> } {
  const json = execFileSync("docker", ["compose", "config", "--format", "json"], { cwd: devnetDir, env, encoding: "utf8" });
  return JSON.parse(json) as { services: Record<string, ComposeService> };
}

describe("docker-compose.yml", () => {
  const { services } = composeConfig();

  it("runs the pinned versions of the spec", () => {
    assert.equal(services[SERVICE.BITCOIND]?.image, "lightninglabs/bitcoin-core:29.4");
    assert.equal(services[SERVICE.LND_HUB]?.image, "lightninglabs/lnd:v0.21.4-beta");
    assert.equal(services[SERVICE.LND_USER]?.image, "lightninglabs/lnd:v0.21.4-beta");
    assert.equal(services[SERVICE.CKB]?.image, "nervos/ckb:v0.202.0");
    assert.equal(services["ckb-miner"]?.image, "nervos/ckb:v0.202.0");
    assert.equal(services[SERVICE.FNN_HUB]?.image, "ckbolt-devnet/fnn:v0.9.1");
    assert.equal(services[SERVICE.FNN_USER]?.image, "ckbolt-devnet/fnn:v0.9.1");
  });

  it("publishes every port on 127.0.0.1 only", () => {
    for (const [name, service] of Object.entries(services)) {
      for (const port of service.ports ?? []) assert.equal(port.host_ip, "127.0.0.1", `${name}:${port.target} is published beyond localhost`);
    }
  });

  it("publishes the ports the hub and the scripts need, on distinct host ports", () => {
    const published = (service: string, target: number) => services[service]?.ports?.find((port) => port.target === target)?.published;
    const needed = [
      published(SERVICE.LND_HUB, CONTAINER_PORT.LND_GRPC),
      published(SERVICE.LND_USER, CONTAINER_PORT.LND_GRPC),
      published(SERVICE.CKB, CONTAINER_PORT.CKB_RPC),
      published(SERVICE.FNN_HUB, CONTAINER_PORT.FNN_RPC),
      published(SERVICE.FNN_USER, CONTAINER_PORT.FNN_RPC),
    ];
    for (const port of needed) assert.ok(port, "a needed port is not published");
    const all = Object.values(services).flatMap((service) => (service.ports ?? []).map((port) => port.published));
    assert.equal(new Set(all).size, all.length, "two services share a host port");
  });

  it("lets every host port be overridden from the environment", () => {
    const moved = composeConfig({ ...process.env, FNN_HUB_RPC_HOST_PORT: "18227", LND_HUB_GRPC_HOST_PORT: "11009" }).services;
    assert.equal(moved[SERVICE.FNN_HUB]?.ports?.[0]?.published, "18227");
    assert.equal(moved[SERVICE.LND_HUB]?.ports?.find((port) => port.target === CONTAINER_PORT.LND_GRPC)?.published, "11009");
  });

  it("binds each fnn RPC to its private compose address, never 0.0.0.0 (no Biscuit key needed)", () => {
    for (const name of [SERVICE.FNN_HUB, SERVICE.FNN_USER]) {
      const address = services[name]?.environment?.RPC_LISTENING_ADDR ?? "";
      assert.equal(address, `${name}:${CONTAINER_PORT.FNN_RPC}`);
    }
  });

  it("has a block producer for CKB and healthchecks on every node", () => {
    assert.ok(services["ckb-miner"]);
    for (const name of Object.values(SERVICE)) assert.ok(services[name]?.healthcheck, `${name} has no healthcheck`);
  });

  it("builds a shared image from one service only, so a first `up` does not race two builds of the same tag", () => {
    const builders = new Map<string, string[]>();
    for (const [name, service] of Object.entries(services)) {
      if (!service.build || !service.image) continue;
      builders.set(service.image, [...(builders.get(service.image) ?? []), name]);
    }
    for (const [image, names] of builders) {
      assert.equal(names.length, 1, `${image} is built by ${names.join(" and ")}: compose builds it twice in parallel and fails with "already exists"`);
    }
  });
});

describe("CKB chain spec and contracts", () => {
  it("ships the Fiber v0.9.1 contract binaries byte for byte", () => {
    for (const [name, sha] of Object.entries(FIBER_V091_CONTRACT_SHA256)) {
      const digest = createHash("sha256").update(readFileSync(join(devnetDir, "ckb", "contracts", name))).digest("hex");
      assert.equal(digest, sha, `ckb/contracts/${name} differs from Fiber v0.9.1`);
    }
  });

  it("puts every Fiber contract in genesis from ckb/contracts", () => {
    const spec = read("ckb/dev.toml");
    for (const name of Object.keys(FIBER_V091_CONTRACT_SHA256)) {
      assert.match(spec, new RegExp(`file = \\{ file = "contracts/${name}" \\}`), `dev.toml does not load contracts/${name}`);
      assert.ok(existsSync(join(devnetDir, "ckb", "contracts", name)));
    }
  });
});

describe("files used inside Linux containers", () => {
  const linuxFiles = ["ckb/docker-entrypoint.sh", "fnn/docker-entrypoint.sh", "fnn/healthcheck.sh", "fnn/Dockerfile", "fnn/config.yml", "ckb/dev.toml", "docker-compose.yml"];

  it("have LF line endings on disk", () => {
    for (const file of linuxFiles) assert.ok(!read(file).includes("\r\n"), `${file} has CRLF endings`);
  });

  it("keep LF on a Windows checkout and keep contract binaries untouched", () => {
    const attributes = read(".gitattributes");
    for (const pattern of ["*.sh", "*.toml", "*.yml", "Dockerfile"]) assert.match(attributes, new RegExp(`^${pattern.replace("*", "\\*").replace(".", "\\.")}\\s+text eol=lf`, "m"));
    assert.match(attributes, /^ckb\/contracts\/\*\s+binary/m);
  });

  it("verifies the fnn v0.9.1 release download by checksum", () => {
    const dockerfile = read("fnn/Dockerfile");
    assert.match(dockerfile, /ARG FNN_VERSION=v0\.9\.1/);
    assert.match(dockerfile, /sha256sum -c/);
    assert.match(dockerfile, /linux-portable\.tar\.gz/);
  });
});

describe("generated secrets and state", () => {
  it("are ignored by git", () => {
    const ignored = read(".gitignore").split(/\r?\n/);
    for (const entry of ["state/", ".secrets/", "hub.env", "node_modules/"]) assert.ok(ignored.includes(entry), `${entry} is not ignored`);
  });
});

describe("README.md", () => {
  const readme = read("README.md");
  const scripts = Object.keys((JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts);

  it("documents every npm script", () => {
    for (const script of scripts) assert.match(readme, new RegExp(`npm run ${script}\\b`), `README does not mention npm run ${script}`);
  });

  it("only names npm scripts that exist (devnet scripts, or the hub's in the section about the hub)", () => {
    const hubScripts = Object.keys((JSON.parse(readFileSync(join(devnetDir, "..", "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts);
    for (const match of readme.matchAll(/npm run ([a-z0-9:-]+)/g)) {
      const script = match[1] as string;
      assert.ok(scripts.includes(script) || hubScripts.includes(script), `README names a missing script: ${script}`);
    }
  });

  it("covers prerequisites, start, bootstrap, smoke test, stop with state, reset, ports and secrets", () => {
    for (const heading of [/## Prerequisites/, /npm run bootstrap/, /npm run smoke/, /docker compose stop/, /npm run reset/, /## Ports and secrets/]) {
      assert.match(readme, heading);
    }
  });
});
