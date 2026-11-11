import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, it } from "node:test";
import { HUB_SOURCE_PATHS } from "../scripts/lib/constants";
import { collectEntries, collectPaths, isExcludedFromSync, modeFor, normalizeLineEndings } from "../scripts/lib/kit-files";
import { resolveDeployPaths } from "../scripts/lib/paths";

/**
 * What `testnet sync` uploads around testnet/add_token.py: the script itself with LF line ends, never Python's bytecode
 * cache, and never the backups the script makes on the server (they hold hub.env, with its secrets).
 */

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

describe("sync and add_token.py", () => {
  for (const path of [
    "__pycache__/add_token.cpython-39.pyc",
    "fnn/__pycache__/x.cpython-312.pyc",
    "backups/add-token-20261107T010203Z/hub.env",
    "backups/add-token-20261107T010203Z/fnn/hub.yml",
    "backups",
  ]) {
    it(`never uploads ${path}`, () => assert.equal(isExcludedFromSync(path), true));
  }

  for (const path of ["add_token.py", "fnn/hub.yml", "fnn/demo.yml", "backups.md", "my-backups/notes.txt", "pycache.txt"]) {
    it(`uploads ${path}`, () => assert.equal(isExcludedFromSync(path), false));
  }

  it("gives Python files LF line endings, and leaves them 644 (they run as `python3 add_token.py`)", () => {
    assert.equal(normalizeLineEndings("add_token.py", Buffer.from("#!/usr/bin/env python3\r\nprint(1)\r\n")).toString(), "#!/usr/bin/env python3\nprint(1)\n");
    assert.equal(normalizeLineEndings("test/python/test_add_token.py", Buffer.from("a\r\n")).toString(), "a\n");
    assert.equal(modeFor("add_token.py"), 0o644);
  });

  it("does not take a .py look-alike for a Python file", () => {
    for (const path of ["notes.pyc", "x.python", "py"]) {
      assert.equal(normalizeLineEndings(path, Buffer.from("a\r\n")).toString(), "a\r\n", path);
    }
  });

  it("skips bytecode caches and backups found in the kit folder, keeping add_token.py", () => {
    const kit = mkdtempSync(join(tmpdir(), "deploy-kit-py-"));
    try {
      writeTree(kit, {
        "add_token.py": "print('ok')\r\n",
        "__pycache__/add_token.cpython-39.pyc": "\u0000bytecode",
        "hub.env": "HUB_PROXY_SECRET=supersecret\n",
        "backups/add-token-20261107T010203Z/hub.env": "HUB_PROXY_SECRET=supersecret\n",
        "backups/add-token-20261107T010203Z/fnn/hub.yml": "ckb: {}\n",
        "fnn/hub.yml": "ckb: {}\n",
      });
      const entries = collectEntries(kit);
      assert.deepEqual(
        entries.map((file) => file.path),
        ["add_token.py", "fnn/hub.yml"],
      );
      assert.equal(entries[0]?.content.toString(), "print('ok')\n");
      assert.ok(!entries.some((file) => file.content.toString().includes("supersecret")));
    } finally {
      rmSync(kit, { recursive: true, force: true });
    }
  });

  it("takes add_token.py from the real kit", () => {
    const files = collectEntries(resolveDeployPaths().kitDir).map((file) => file.path);
    assert.ok(files.includes("add_token.py"), "add_token.py missing from the upload");
  });

  it("loses no file of the hub's sources to the new exclusions (no folder there is called backups)", () => {
    const paths = resolveDeployPaths();
    const uploaded = collectPaths(paths.hubRoot, HUB_SOURCE_PATHS).map((file) => file.path);
    assert.ok(uploaded.includes("src/interfaces/cli/fnn-whitelist/main.ts"), "the generator the image runs is uploaded");
    const named = HUB_SOURCE_PATHS.flatMap((path) => {
      const absolute = join(paths.hubRoot, path);
      if (!statSync(absolute).isDirectory()) return [];
      return readdirSync(absolute, { recursive: true, encoding: "utf8" }).map((child) => `${path}/${child.split(sep).join("/")}`);
    });
    assert.deepEqual(named.filter((path) => !/(^|\/)(node_modules|dist|\.git)(\/|$)/.test(path) && /(^|\/)backups(\/|$)/.test(path)), []);
  });
});
