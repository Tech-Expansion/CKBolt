import { decodeMoleculeScript } from "../../../src/common/utils/molecule.util";
import type { Script } from "../../../src/domain/types";
import {
  encodeMoleculeBytes,
  encodeMoleculeScript,
  encodeMoleculeTable,
  RUSD_SCRIPT,
  RUSD_SCRIPT_MOLECULE,
  scriptFields,
} from "./fiber.fixtures";

const toHex = (bytes: Buffer): string => `0x${bytes.toString("hex")}`;

describe("decodeMoleculeScript (udt_script attribute of Fiber invoices)", () => {
  describe("valid scripts", () => {
    it("decodes the hand-encoded testnet RUSD script", () => {
      expect(decodeMoleculeScript(RUSD_SCRIPT_MOLECULE)).toEqual(RUSD_SCRIPT);
    });

    it("agrees with an independent encoder on the RUSD script", () => {
      expect(encodeMoleculeScript(RUSD_SCRIPT)).toBe(RUSD_SCRIPT_MOLECULE);
    });

    it.each<[Script["hashType"], number]>([
      ["data", 0],
      ["type", 1],
      ["data1", 2],
      ["data2", 4],
    ])("maps hash_type byte %s (%i)", (hashType) => {
      const script: Script = { ...RUSD_SCRIPT, hashType };
      expect(decodeMoleculeScript(encodeMoleculeScript(script))).toEqual(script);
    });

    it("decodes empty args as 0x", () => {
      const script: Script = { ...RUSD_SCRIPT, args: "0x" };
      expect(decodeMoleculeScript(encodeMoleculeScript(script))).toEqual(script);
    });

    it("decodes long args (xUDT args with an extension)", () => {
      const script: Script = { ...RUSD_SCRIPT, args: `0x${"7e".repeat(68)}` };
      expect(decodeMoleculeScript(encodeMoleculeScript(script))).toEqual(script);
    });

    it("accepts hex without 0x and upper-case digits, and returns lower-case 0x hex", () => {
      const upper = RUSD_SCRIPT_MOLECULE.slice(2).toUpperCase();
      expect(decodeMoleculeScript(upper)).toEqual(RUSD_SCRIPT);
    });

    it("ignores extra fields of a newer, compatible table", () => {
      const extended = encodeMoleculeScript(RUSD_SCRIPT, [Buffer.from("extra"), Buffer.from([1, 2, 3])]);
      expect(decodeMoleculeScript(extended)).toEqual(RUSD_SCRIPT);
    });
  });

  describe("malformed input throws", () => {
    const valid = Buffer.from(RUSD_SCRIPT_MOLECULE.slice(2), "hex");

    const withU32 = (bytes: Buffer, offset: number, value: number): Buffer => {
      const copy = Buffer.from(bytes);
      copy.writeUInt32LE(value, offset);
      return copy;
    };

    it.each<[string, string]>([
      ["an empty string", ""],
      ["0x alone", "0x"],
      ["odd-length hex", `${RUSD_SCRIPT_MOLECULE}0`],
      ["non-hex characters", `0x${"zz".repeat(85)}`],
      ["fewer than 4 bytes", "0x5500"],
      ["a total size that does not match the bytes", toHex(withU32(valid, 0, valid.length + 1))],
      ["trailing bytes after the table", toHex(Buffer.concat([valid, Buffer.from([0])]))],
      ["a truncated table", toHex(valid.subarray(0, valid.length - 1))],
      ["an empty table (no fields)", toHex(encodeMoleculeTable([]))],
      ["a table with only two fields", toHex(encodeMoleculeTable(scriptFields(RUSD_SCRIPT).slice(0, 2)))],
      ["a header size that is not a multiple of 4", toHex(withU32(valid, 4, 15))],
      ["a header larger than the table", toHex(withU32(valid, 4, 200))],
      ["offsets out of order", toHex(withU32(valid, 8, 60))],
      ["an offset inside the header", toHex(withU32(withU32(valid, 4, 16), 8, 8))],
    ])("rejects %s", (_label, input) => {
      expect(() => decodeMoleculeScript(input)).toThrow();
    });

    it("rejects a code_hash that is not 32 bytes", () => {
      const fields = scriptFields(RUSD_SCRIPT);
      const shortHash = encodeMoleculeTable([Buffer.alloc(31, 0x11), fields[1]!, fields[2]!]);
      expect(() => decodeMoleculeScript(toHex(shortHash))).toThrow(/Byte32/);
    });

    it.each([3, 5, 255])("rejects the unknown hash_type byte %i", (byte) => {
      const fields = scriptFields(RUSD_SCRIPT);
      const table = encodeMoleculeTable([fields[0]!, Buffer.from([byte]), fields[2]!]);
      expect(() => decodeMoleculeScript(toHex(table))).toThrow(/hash_type/);
    });

    it("rejects a hash_type field longer than one byte", () => {
      const fields = scriptFields(RUSD_SCRIPT);
      const table = encodeMoleculeTable([fields[0]!, Buffer.from([1, 0]), fields[2]!]);
      expect(() => decodeMoleculeScript(toHex(table))).toThrow(/hash_type/);
    });

    it("rejects args whose fixvec length disagrees with its bytes", () => {
      const fields = scriptFields(RUSD_SCRIPT);
      const args = encodeMoleculeBytes(Buffer.alloc(20, 0x22));
      args.writeUInt32LE(21, 0);
      const table = encodeMoleculeTable([fields[0]!, fields[1]!, args]);
      expect(() => decodeMoleculeScript(toHex(table))).toThrow(/Bytes/);
    });

    it("rejects args shorter than the fixvec header", () => {
      const fields = scriptFields(RUSD_SCRIPT);
      const table = encodeMoleculeTable([fields[0]!, fields[1]!, Buffer.from([0, 0])]);
      expect(() => decodeMoleculeScript(toHex(table))).toThrow(/Bytes/);
    });
  });
});
