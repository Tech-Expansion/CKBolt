import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readAmount, readCount, readPrivateKey } from "../../scripts/lib/env";

const KEY = `0x${"ab".repeat(32)}`;

describe("readCount", () => {
  it("returns the fallback when the variable is missing, empty or blank", () => {
    assert.equal(readCount({}, "N", 7), 7);
    assert.equal(readCount({ N: "" }, "N", 7), 7);
    assert.equal(readCount({ N: "   " }, "N", 7), 7);
  });

  it("reads a non-negative integer, trimming spaces", () => {
    assert.equal(readCount({ N: "0" }, "N", 7), 0);
    assert.equal(readCount({ N: " 42 " }, "N", 7), 42);
  });

  it("rejects negatives, decimals, hex, words and unsafe integers with the variable name", () => {
    for (const bad of ["-1", "1.5", "0x10", "ten", "1e3", String(Number.MAX_SAFE_INTEGER + 2)]) {
      assert.throws(() => readCount({ N: bad }, "N", 7), new RegExp(`^Error: N=.* is not a non-negative integer`));
    }
  });
});

describe("readAmount", () => {
  it("returns the fallback when missing", () => {
    assert.equal(readAmount({}, "A", 5n), 5n);
  });

  it("reads amounts beyond Number.MAX_SAFE_INTEGER exactly", () => {
    assert.equal(readAmount({ A: "340282366920938463463374607431768211455" }, "A", 0n), 2n ** 128n - 1n);
  });

  it("rejects anything that is not a whole number of base units", () => {
    for (const bad of ["-5", "1.0", "0x1", "1_000"]) {
      assert.throws(() => readAmount({ A: bad }, "A", 0n), /is not a non-negative integer amount in base units/);
    }
  });
});

describe("readPrivateKey", () => {
  it("returns the fallback when missing and a valid key when set", () => {
    assert.equal(readPrivateKey({}, "K", KEY), KEY);
    const other = `0x${"CD".repeat(32)}`;
    assert.equal(readPrivateKey({ K: other }, "K", KEY), other);
  });

  it("rejects malformed keys without echoing the secret", () => {
    const leaked = `${"12".repeat(32)}`; // no 0x prefix
    for (const bad of [leaked, "0x1234", `0x${"zz".repeat(32)}`, `${KEY}00`]) {
      assert.throws(
        () => readPrivateKey({ K: bad }, "K", KEY),
        (error: Error) => error.message.includes("<hidden>") && !error.message.includes(bad),
      );
    }
  });
});
