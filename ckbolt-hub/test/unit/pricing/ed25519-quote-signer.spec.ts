import { Ed25519QuoteSigner } from "../../../src/application/pricing/ed25519-quote-signer";
import { hubConfig, SIGNING_SEED_HEX } from "./pricing.fixtures";

const signerWith = (signingKeyHex: string | null) => new Ed25519QuoteSigner(hubConfig({ pricing: { signingKeyHex } }));

/** RFC 8032 section 7.1, tests 1 and 2: Ed25519 (pure) with a known seed. */
const RFC8032 = [
  {
    name: "test 1 (empty message)",
    seed: SIGNING_SEED_HEX,
    publicKey: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    message: "",
    signature:
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  },
  {
    name: "test 2 (message 0x72)",
    seed: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
    publicKey: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    message: "r",
    signature:
      "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  },
];

const HEX_64_BYTES = /^[0-9a-f]{128}$/;
const HEX_32_BYTES = /^[0-9a-f]{64}$/;

describe("Ed25519QuoteSigner", () => {
  it.each(RFC8032)("matches RFC 8032 $name", ({ seed, publicKey, message, signature }) => {
    const signer = signerWith(seed);

    expect(signer.publicKeyHex).toBe(publicKey);
    expect(signer.sign(message)).toBe(signature);
    expect(signer.verify(message, signature, publicKey)).toBe(true);
  });

  it("accepts the configured seed in upper case", () => {
    expect(signerWith(SIGNING_SEED_HEX.toUpperCase()).publicKeyHex).toBe(RFC8032[0]?.publicKey);
  });

  it("signs as lowercase hex: 64-byte signature, 32-byte public key", () => {
    const signer = signerWith(null);

    expect(signer.publicKeyHex).toMatch(HEX_32_BYTES);
    expect(signer.sign("ckbolt-quote-v1:{}")).toMatch(HEX_64_BYTES);
  });

  it("with a configured seed, keeps the same key across restarts so earlier quotes still verify", () => {
    const before = signerWith(SIGNING_SEED_HEX);
    const after = signerWith(SIGNING_SEED_HEX);
    const signature = before.sign("quote");

    expect(after.publicKeyHex).toBe(before.publicKeyHex);
    expect(after.verify("quote", signature, before.publicKeyHex)).toBe(true);
  });

  it("without a seed, generates a new key per process", () => {
    const first = signerWith(null);
    const second = signerWith(null);
    const signature = first.sign("quote");

    expect(second.publicKeyHex).not.toBe(first.publicKeyHex);
    expect(first.verify("quote", signature, first.publicKeyHex)).toBe(true);
    expect(second.verify("quote", signature, second.publicKeyHex)).toBe(false);
  });

  it("keeps one key for the life of an instance", () => {
    const signer = signerWith(null);
    const key = signer.publicKeyHex;
    signer.sign("a");
    signer.sign("b");

    expect(signer.publicKeyHex).toBe(key);
  });

  it("signs UTF-8 text (non-ASCII price sources or ids)", () => {
    const signer = signerWith(null);
    const message = "ckbolt-quote-v1:{\"priceSource\":\"médian:ü€\"}";

    expect(signer.verify(message, signer.sign(message), signer.publicKeyHex)).toBe(true);
    expect(signer.verify(message.normalize("NFD"), signer.sign(message), signer.publicKeyHex)).toBe(false);
  });

  describe("verify rejects and never throws", () => {
    const signer = signerWith(SIGNING_SEED_HEX);
    const message = "ckbolt-quote-v1:{\"sats\":\"10000\"}";
    const signature = signer.sign(message);
    const flipLastHexDigit = (hex: string) => hex.slice(0, -1) + (hex.endsWith("0") ? "1" : "0");

    it.each([
      ["a changed message", "ckbolt-quote-v1:{\"sats\":\"10001\"}", signature, signer.publicKeyHex],
      ["a changed signature", message, flipLastHexDigit(signature), signer.publicKeyHex],
      ["another hub's key", message, signature, RFC8032[1]?.publicKey ?? ""],
      ["an empty signature", message, "", signer.publicKeyHex],
      ["a signature that is not hex", message, "zz".repeat(64), signer.publicKeyHex],
      ["a signature of the wrong length", message, signature.slice(2), signer.publicKeyHex],
      ["an odd-length signature", message, `${signature}0`, signer.publicKeyHex],
      ["an empty public key", message, signature, ""],
      ["a public key that is not hex", message, signature, "xy".repeat(32)],
      ["a public key of the wrong length", message, signature, `${signer.publicKeyHex}00`],
      ["a 0x-prefixed public key", message, signature, `0x${signer.publicKeyHex}`],
      ["an all-zero signature", message, "00".repeat(64), signer.publicKeyHex],
    ])("%s", (_label, msg, sig, key) => {
      let result: boolean | undefined;
      expect(() => {
        result = signer.verify(msg, sig, key);
      }).not.toThrow();
      expect(result).toBe(false);
    });

    it("an invalid curve point as the public key", () => {
      expect(signer.verify(message, signature, "ff".repeat(32))).toBe(false);
    });
  });
});
