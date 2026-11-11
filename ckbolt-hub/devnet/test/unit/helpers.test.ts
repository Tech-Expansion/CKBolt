import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { xudtAmountData } from "../../scripts/lib/ckb";
import { writeTextFile } from "../../scripts/lib/files";
import { newPaymentSecret } from "../../scripts/lib/payment-secret";

describe("newPaymentSecret", () => {
  it("makes a 32-byte preimage and its SHA-256 as lowercase hex without 0x", () => {
    const { preimage, paymentHash } = newPaymentSecret();
    assert.match(preimage, /^[0-9a-f]{64}$/);
    assert.equal(paymentHash, createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex"));
  });

  it("never repeats a preimage (one hash per swap)", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newPaymentSecret().preimage));
    assert.equal(seen.size, 200);
  });
});

describe("xudtAmountData", () => {
  it("encodes the amount as a 16-byte little-endian u128", () => {
    assert.equal(xudtAmountData(0n), `0x${"00".repeat(16)}`);
    assert.equal(xudtAmountData(1n), `0x01${"00".repeat(15)}`);
    assert.equal(xudtAmountData(100_000_000_000_000n), "0x00407a10f35a00000000000000000000");
    assert.equal(xudtAmountData(2n ** 128n - 1n), `0x${"ff".repeat(16)}`);
  });
});

describe("writeTextFile", () => {
  it("creates missing folders, reports a change, and skips an identical rewrite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "devnet-files-"));
    try {
      const path = join(dir, "state", "nested", "fnn-udt.env");
      assert.equal(await writeTextFile(path, "A=1\n"), true);
      assert.equal(await writeTextFile(path, "A=1\n"), false);
      assert.equal(await writeTextFile(path, "A=2\n"), true);
      assert.equal(await readFile(path, "utf8"), "A=2\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
