import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import { HUB_SOURCE_PATHS } from "../scripts/lib/constants";
import { collectEntries, collectPaths, isExcludedFromSync, modeFor, normalizeLineEndings } from "../scripts/lib/kit-files";
import { resolveDeployPaths } from "../scripts/lib/paths";
import { createTar, createTarGz, splitTarPath, TAR_BLOCK_BYTES, type TarEntry } from "../scripts/lib/tar";
import { replaceDirScript, syncKit, unpackScript } from "../scripts/steps/sync.step";
import { hasPosixShell, runLocalSh, testContext } from "./support/fakes";
import { readTar, readTarGz } from "./support/tar-reader";

const entry = (path: string, content: string, mode = 0o644): TarEntry => ({ path, content: Buffer.from(content), mode, mtimeSeconds: 1_760_000_000 });

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

describe("tar writer", () => {
  it("writes valid ustar headers, padded content and two end blocks", () => {
    const archive = createTar([entry("a.txt", "hello"), entry("dir/b.sh", "#!/bin/sh\n", 0o755), entry("empty", "")]);
    assert.equal(archive.length % TAR_BLOCK_BYTES, 0);
    const read = readTar(archive);
    assert.deepEqual(
      read.map((file) => [file.path, file.mode, file.content.toString(), file.uid, file.gid, file.mtime]),
      [
        ["a.txt", 0o644, "hello", 0, 0, 1_760_000_000],
        ["dir/b.sh", 0o755, "#!/bin/sh\n", 0, 0, 1_760_000_000],
        ["empty", 0o644, "", 0, 0, 1_760_000_000],
      ],
    );
  });

  it("keeps content exactly at block boundaries and for binary data", () => {
    const exact = Buffer.alloc(TAR_BLOCK_BYTES, 7);
    const binary = Buffer.from([0, 255, 13, 10, 0, 1]);
    const read = readTar(createTar([{ ...entry("x", ""), content: exact }, { ...entry("y", ""), content: binary }]));
    assert.ok(read[0]?.content.equals(exact));
    assert.ok(read[1]?.content.equals(binary));
  });

  it("moves leading folders into the prefix field for long paths and refuses paths no field can hold", () => {
    const long = `${"d".repeat(60)}/${"e".repeat(60)}/file.ts`;
    const split = splitTarPath(long);
    assert.equal(`${split.prefix}/${split.name}`, long);
    assert.ok(Buffer.byteLength(split.name) <= 100 && Buffer.byteLength(split.prefix) <= 155);
    assert.deepEqual(splitTarPath("short/path.ts"), { name: "short/path.ts", prefix: "" });
    assert.equal(readTar(createTar([entry(long, "x")]))[0]?.path, long);
    assert.throws(() => splitTarPath(`${"x".repeat(101)}`), /too long/);
    assert.throws(() => splitTarPath(`${"p".repeat(156)}/${"n".repeat(10)}`), /too long/);
  });

  it("gzips the archive", () => {
    const gz = createTarGz([entry("a", "b")]);
    assert.equal(gz[0], 0x1f);
    assert.equal(gz[1], 0x8b);
    assert.equal(readTarGz(gz)[0]?.content.toString(), "b");
  });

  it("is unpacked by a real tar with the same paths, contents and modes", { skip: spawnSync("tar", ["--version"]).status !== 0 && "no tar" }, () => {
    const dir = tempDir("deploy-tar-");
    try {
      writeFileSync(join(dir, "kit.tgz"), createTarGz([entry("lnd/init-wallet.sh", "#!/bin/sh\necho ok\n", 0o755), entry(`${"d".repeat(90)}/${"f".repeat(40)}.yml`, "a: 1\n")]));
      mkdirSync(join(dir, "out"));
      const run = spawnSync("tar", ["-xzf", "kit.tgz", "-C", "out"], { cwd: dir, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(readFileSync(join(dir, "out", "lnd", "init-wallet.sh"), "utf8"), "#!/bin/sh\necho ok\n");
      assert.equal(readFileSync(join(dir, "out", "d".repeat(90), `${"f".repeat(40)}.yml`), "utf8"), "a: 1\n");
      if (process.platform !== "win32") assert.equal(statSync(join(dir, "out", "lnd", "init-wallet.sh")).mode & 0o777, 0o755);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("what sync uploads", () => {
  for (const path of [
    ".env",
    "hub.env",
    "deploy.env",
    "secrets/wallet/lnd-hub.password",
    "secrets/hub/lnd-hub/hub.macaroon",
    "lnd-hub.seed",
    "secrets/wallet/lnd-hub.seed.pending",
    "data/hub.sqlite",
    "node_modules/x/index.js",
    "src/node_modules/y.js",
    "dist/main.js",
    ".git/config",
    "notes.seed",
  ]) {
    it(`never uploads ${path}`, () => assert.equal(isExcludedFromSync(path), true));
  }

  for (const path of [".env.example", "hub.env.example", "docker-compose.yml", "lnd/init-wallet.sh", "src/config/env-file.ts", "deploy/testnet/hub/Dockerfile"]) {
    it(`uploads ${path}`, () => assert.equal(isExcludedFromSync(path), false));
  }

  it("gives Linux files LF line endings and leaves other files as they are", () => {
    const crlf = Buffer.from("a\r\nb\r\n");
    for (const path of ["lnd/init-wallet.sh", "docker-compose.yml", "fnn/hub.yaml", "x.conf", ".env.example", "hub.env.example", "bitcoind/Dockerfile", "hub/Dockerfile.dockerignore"]) {
      assert.equal(normalizeLineEndings(path, crlf).toString(), "a\nb\n", path);
    }
    assert.equal(normalizeLineEndings("src/main.ts", crlf).toString(), "a\r\nb\r\n");
    const png = Buffer.from([0x89, 0x50, 0x0d, 0x0a]);
    assert.ok(normalizeLineEndings("logo.png", png).equals(png));
  });

  it("makes shell scripts executable and everything else 644", () => {
    assert.equal(modeFor("lnd/init-wallet.sh"), 0o755);
    assert.equal(modeFor("docker-compose.yml"), 0o644);
  });

  it("skips secrets found anywhere in the kit folder, keeping the rest in a stable order", () => {
    const kit = tempDir("deploy-kit-");
    try {
      writeTree(kit, {
        "docker-compose.yml": "services: {}\r\n",
        ".env": "QUOTE_SIGNING_KEY=deadbeefsecret\n",
        ".env.example": "QUOTE_SIGNING_KEY=\n",
        "hub.env": "X=1\n",
        "secrets/wallet/lnd-hub.password": "walletpasswordsecret",
        "secrets/wallet/lnd-hub.seed": "abandon ability able",
        "lnd/init-wallet.sh": "#!/bin/sh\r\n",
        "fnn/hub.yml": "a: 1\n",
      });
      const entries = collectEntries(kit);
      assert.deepEqual(
        entries.map((file) => file.path),
        [".env.example", "docker-compose.yml", "fnn/hub.yml", "lnd/init-wallet.sh"],
      );
      assert.equal(entries.find((file) => file.path === "lnd/init-wallet.sh")?.mode, 0o755);
      assert.equal(entries.find((file) => file.path === "docker-compose.yml")?.content.toString(), "services: {}\n");
    } finally {
      rmSync(kit, { recursive: true, force: true });
    }
  });

  it("takes the whole real kit (compose files, examples, fnn configs, wallet script, Dockerfiles) and nothing secret", () => {
    const paths = resolveDeployPaths();
    const files = collectEntries(paths.kitDir).map((file) => file.path);
    for (const required of [
      "docker-compose.yml",
      "docker-compose.public.yml",
      ".env.example",
      "hub.env.example",
      "fnn/hub.yml",
      "fnn/demo.yml",
      "lnd/init-wallet.sh",
      "bitcoind/Dockerfile",
      "hub/Dockerfile",
    ]) {
      assert.ok(files.includes(required), `${required} missing from the upload`);
    }
    assert.deepEqual(files.filter((path) => isExcludedFromSync(path)), []);
    assert.ok(!files.includes("fnn/config.yml"), "the old shared fnn config is gone");
  });

  it("takes what the images build from out of the hub repository, without node_modules or build output", () => {
    const paths = resolveDeployPaths();
    const files = collectPaths(paths.hubRoot, HUB_SOURCE_PATHS).map((file) => file.path);
    for (const required of ["package.json", "package-lock.json", "tsconfig.json", "src/main.ts", "deploy/testnet/hub/Dockerfile", "devnet/fnn/Dockerfile"]) {
      assert.ok(files.includes(required), `${required} missing from the source upload`);
    }
    assert.equal(files.filter((path) => /(^|\/)(node_modules|dist|\.git)\//.test(path)).length, 0);
    assert.equal(files.filter((path) => path.startsWith("test/") || path.startsWith("deploy/scripts/")).length, 0, "only what the images need");
  });
});

describe("testnet sync", () => {
  it("uploads the kit into the kit folder and the hub source into src/, without .env, hub.env, secrets or seeds", async () => {
    const kit = tempDir("deploy-kit-");
    try {
      writeTree(kit, {
        "docker-compose.yml": "name: ckbolt-testnet\n",
        ".env": "BITCOIND_RPC_PASSWORD=bitcoindsecretvalue\n",
        "hub.env": "SECRET_LOOKING=hubenvsecretvalue\n",
        "secrets/wallet/lnd-hub.password": "walletsecretvalue",
        "lnd-hub.seed": "seedwordssecretvalue",
      });
      const { ctx, runner, logger } = testContext();
      ctx.paths.kitDir = kit;
      await syncKit(ctx);

      assert.equal(runner.calls.filter((call) => call.input !== "").length, 2, "two uploads; the whitelist regeneration after them sends nothing");
      const [kitCall, sourceCall] = runner.calls;
      assert.equal(kitCall?.script, unpackScript("/opt/ckbolt/testnet"));
      assert.equal(sourceCall?.script, replaceDirScript("/opt/ckbolt/testnet/src"));
      const kitArchive = Buffer.from(kitCall?.input ?? "", "base64");
      assert.deepEqual(readTarGz(kitArchive).map((file) => file.path), ["docker-compose.yml"]);
      const plain = gunzipSync(kitArchive).toString("latin1");
      for (const secret of ["bitcoindsecretvalue", "hubenvsecretvalue", "walletsecretvalue", "seedwordssecretvalue"]) {
        assert.ok(!plain.includes(secret), `${secret} was uploaded`);
      }
      const sourcePaths = readTarGz(Buffer.from(sourceCall?.input ?? "", "base64")).map((file) => file.path);
      assert.ok(sourcePaths.includes("src/main.ts"));
      assert.match(logger.text(), /kit: 1 files/);
    } finally {
      rmSync(kit, { recursive: true, force: true });
    }
  });

  it("never deletes anything in the kit folder: the kit is unpacked over it, only src/ is replaced", () => {
    const kitScript = unpackScript("/opt/ckbolt/testnet");
    assert.doesNotMatch(kitScript, /\brm\b/);
    assert.match(kitScript, /--no-same-owner/);
    const sourceScript = replaceDirScript("/opt/ckbolt/testnet/src");
    const removed = [...sourceScript.matchAll(/rm -rf (\S+)/g)].map((match) => match[1]);
    assert.deepEqual(removed, ["/opt/ckbolt/testnet/src.incoming", "/opt/ckbolt/testnet/src"]);
  });

  it("swaps src/ in only once the new archive unpacked, keeping .env, hub.env and secrets (real sh and tar)", { skip: !hasPosixShell() && "no local sh" }, () => {
    const server = tempDir("deploy-server-");
    try {
      writeTree(server, {
        ".env": "KEEP=1\n",
        "hub.env": "KEEP=2\n",
        "secrets/wallet/lnd-hub.password": "pw",
        "src/old-file.ts": "old",
      });
      const archive = createTarGz([entry("package.json", "{}"), entry("src/main.ts", "new")]);
      writeFileSync(join(server, "upload.tgz"), archive);
      const replaced = runLocalSh(`(${replaceDirScript("src")}) < upload.tgz`, server);
      assert.equal(replaced.status, 0, replaced.stderr);
      assert.equal(readFileSync(join(server, "src", "src", "main.ts"), "utf8"), "new");
      assert.throws(() => statSync(join(server, "src", "old-file.ts")), "files deleted locally do not linger");
      assert.equal(readFileSync(join(server, ".env"), "utf8"), "KEEP=1\n");
      assert.equal(readFileSync(join(server, "hub.env"), "utf8"), "KEEP=2\n");
      assert.equal(readFileSync(join(server, "secrets", "wallet", "lnd-hub.password"), "utf8"), "pw");
      writeFileSync(join(server, "broken.tgz"), Buffer.from("not an archive"));
      const failed = runLocalSh(`(${replaceDirScript("src")}) < broken.tgz`, server);
      assert.notEqual(failed.status, 0);
      assert.equal(readFileSync(join(server, "src", "src", "main.ts"), "utf8"), "new", "a failed upload leaves the previous source");
    } finally {
      rmSync(server, { recursive: true, force: true });
    }
  });
});
