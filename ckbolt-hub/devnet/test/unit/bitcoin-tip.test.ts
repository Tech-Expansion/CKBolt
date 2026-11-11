/**
 * Independent tests of the recorded Bitcoin tip (lib/bitcoin-tip.ts): state/bitcoin-tip.json is written after every
 * mine and read by `npm run up`; a missing or damaged record must only lose the exact heal, never fail `up`.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FileTipStore, parseChainTip, type ChainTip } from "../../scripts/lib/bitcoin-tip";
import { resolveDevnetPaths } from "../../scripts/lib/paths";

/** What gettxoutsetinfo printed on the running devnet (2026-10-23). */
const LIVE_TIP: ChainTip = { height: 183, hash: "546d57044117eaf68868fcb2b9d32e34b569a2646c3f311d524f87afe0b77d60" };

async function withDevnetDir(run: (store: FileTipStore, file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "devnet-tip-"));
  try {
    const file = resolveDevnetPaths(dir).bitcoinTipFile;
    await run(new FileTipStore(file), file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("FileTipStore", () => {
  it("has no record before the first mine (or after `npm run reset` deleted state/)", async () => {
    await withDevnetDir(async (store) => assert.equal(await store.load(), null));
  });

  it("creates state/ when it is missing and reads back what it saved", async () => {
    await withDevnetDir(async (store, file) => {
      await store.save(LIVE_TIP);
      assert.deepEqual(await store.load(), LIVE_TIP);
      assert.ok(file.endsWith(join("state", "bitcoin-tip.json")));
    });
  });

  it("writes plain JSON of height and hash only, ending in a newline", async () => {
    await withDevnetDir(async (store, file) => {
      await store.save(LIVE_TIP);
      const text = await readFile(file, "utf8");
      assert.ok(text.endsWith("}\n"));
      assert.deepEqual(JSON.parse(text), LIVE_TIP);
      assert.deepEqual(Object.keys(JSON.parse(text) as object).sort(), ["hash", "height"]);
    });
  });

  it("keeps only the latest tip: every mine replaces the record", async () => {
    await withDevnetDir(async (store) => {
      await store.save({ height: 177, hash: "a".repeat(64) });
      await store.save({ height: 178, hash: "b".repeat(64) });
      await store.save(LIVE_TIP);
      assert.deepEqual(await store.load(), LIVE_TIP);
    });
  });

  it("returns null, not an error, for a record a crash cut short or a damaged file", async () => {
    await withDevnetDir(async (store, file) => {
      await mkdir(join(file, ".."), { recursive: true });
      for (const damaged of ["", '{\n  "height": 18', "\u0000\u0000\u0000", "not json", '{"height":"183","hash":"x"}']) {
        await writeFile(file, damaged, "utf8");
        assert.equal(await store.load(), null, JSON.stringify(damaged));
      }
    });
  });

  it("returns null when the path cannot be read as a file", async () => {
    await withDevnetDir(async (store, file) => {
      await mkdir(file, { recursive: true });
      assert.equal(await store.load(), null);
    });
  });
});

describe("parseChainTip", () => {
  it("reads the record as written, with Windows line endings or extra fields", () => {
    assert.deepEqual(parseChainTip(JSON.stringify(LIVE_TIP, null, 2)), LIVE_TIP);
    assert.deepEqual(parseChainTip(JSON.stringify(LIVE_TIP, null, 2).replace(/\n/g, "\r\n")), LIVE_TIP);
    assert.deepEqual(parseChainTip(JSON.stringify({ ...LIVE_TIP, txouts: 185 })), LIVE_TIP);
  });

  it("accepts height 0 (genesis)", () => {
    assert.deepEqual(parseChainTip(JSON.stringify({ height: 0, hash: LIVE_TIP.hash })), { height: 0, hash: LIVE_TIP.hash });
  });

  it("rejects heights that are not whole non-negative safe numbers", () => {
    for (const height of [-1, 1.5, "183", null, true, Number.MAX_SAFE_INTEGER + 2]) {
      assert.equal(parseChainTip(JSON.stringify({ height, hash: LIVE_TIP.hash })), null, String(height));
    }
  });

  it("rejects hashes that are not 64 hex characters as bitcoin-cli prints them", () => {
    for (const hash of ["", "0x" + LIVE_TIP.hash.slice(2), LIVE_TIP.hash.slice(1), `${LIVE_TIP.hash}0`, "g".repeat(64), 42, null]) {
      assert.equal(parseChainTip(JSON.stringify({ height: 183, hash })), null, String(hash));
    }
  });

  it("rejects JSON that is not one object", () => {
    for (const text of ["null", "183", '"183"', "[]", `[${JSON.stringify(LIVE_TIP)}]`, `${JSON.stringify(LIVE_TIP)} trailing`]) {
      assert.equal(parseChainTip(text), null, text);
    }
  });
});
