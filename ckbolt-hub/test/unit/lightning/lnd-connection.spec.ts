import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authenticatedLndGrpc, type AuthenticatedLnd } from "lightning";
import type { LndConnection } from "../../../src/config/hub.config";
import { connectLnd, disconnectLnd, lndGrpcAuth } from "../../../src/infrastructure/lightning/lnd-connection";

jest.mock("lightning", () => ({ ...jest.requireActual<object>("lightning"), authenticatedLndGrpc: jest.fn() }));

const mockedAuthenticatedLndGrpc = authenticatedLndGrpc as jest.MockedFunction<typeof authenticatedLndGrpc>;

const CERT_PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const CERT_BASE64 = Buffer.from(CERT_PEM).toString("base64");
const MACAROON_BYTES = Buffer.from([0x02, 0x01, 0x03, 0x6c, 0x6e, 0x64]);
const MACAROON_HEX = MACAROON_BYTES.toString("hex");
const HOST = "hub-lnd:10009";

const connection = (patch: Partial<LndConnection> = {}): LndConnection => ({ grpcHost: HOST, tlsCertBase64: CERT_BASE64, macaroonHex: MACAROON_HEX, ...patch });

describe("lndGrpcAuth", () => {
  it("uses inline credentials as they are, with the gRPC host as socket", () => {
    const readFile = jest.fn();
    expect(lndGrpcAuth(connection(), readFile)).toEqual({ cert: CERT_BASE64, macaroon: MACAROON_HEX, socket: HOST });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("trims whitespace around inline credentials (copied from a terminal)", () => {
    expect(lndGrpcAuth(connection({ tlsCertBase64: ` ${CERT_BASE64}\n`, macaroonHex: `${MACAROON_HEX}\r\n` }), jest.fn())).toMatchObject({
      cert: CERT_BASE64,
      macaroon: MACAROON_HEX,
    });
  });

  it("prefers the inline value when both an inline value and a path are set", () => {
    const readFile = jest.fn();
    lndGrpcAuth(connection({ tlsCertPath: "/lnd/tls.cert", macaroonPath: "/lnd/hub.macaroon" }), readFile);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("reads files: the certificate as base64 of the PEM, the macaroon as hex of its bytes", () => {
    const files: Record<string, Buffer> = { "/lnd/tls.cert": Buffer.from(CERT_PEM), "/lnd/hub.macaroon": MACAROON_BYTES };
    const readFile = jest.fn((path: string) => files[path]!);
    const auth = lndGrpcAuth({ grpcHost: HOST, tlsCertPath: "/lnd/tls.cert", macaroonPath: "/lnd/hub.macaroon" }, readFile);
    expect(auth).toEqual({ cert: CERT_BASE64, macaroon: MACAROON_HEX, socket: HOST });
    expect(readFile).toHaveBeenCalledWith("/lnd/tls.cert");
    expect(readFile).toHaveBeenCalledWith("/lnd/hub.macaroon");
  });

  it("falls back to the file when the inline value is blank", () => {
    const readFile = jest.fn(() => MACAROON_BYTES);
    expect(lndGrpcAuth(connection({ macaroonHex: "   ", macaroonPath: "/lnd/hub.macaroon" }), readFile).macaroon).toBe(MACAROON_HEX);
  });

  it("throws, naming the host, when the TLS certificate is missing", () => {
    expect(() => lndGrpcAuth(connection({ tlsCertBase64: undefined }), jest.fn())).toThrow(/hub-lnd:10009.*TLS certificate/);
  });

  it("throws, naming the host, when the macaroon is missing or blank", () => {
    expect(() => lndGrpcAuth(connection({ macaroonHex: undefined }), jest.fn())).toThrow(/hub-lnd:10009.*macaroon/);
    expect(() => lndGrpcAuth(connection({ macaroonHex: "  " }), jest.fn())).toThrow(/macaroon/);
  });

  it("lets a missing credential file fail loudly", () => {
    const readFile = jest.fn(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    });
    expect(() => lndGrpcAuth({ grpcHost: HOST, tlsCertPath: "/missing/tls.cert", macaroonHex: MACAROON_HEX }, readFile)).toThrow(/ENOENT/);
  });

  it("reads real files by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "ckbolt-lnd-"));
    try {
      writeFileSync(join(dir, "tls.cert"), CERT_PEM);
      writeFileSync(join(dir, "hub.macaroon"), MACAROON_BYTES);
      expect(lndGrpcAuth({ grpcHost: HOST, tlsCertPath: join(dir, "tls.cert"), macaroonPath: join(dir, "hub.macaroon") })).toEqual({
        cert: CERT_BASE64,
        macaroon: MACAROON_HEX,
        socket: HOST,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("connectLnd", () => {
  beforeEach(() => mockedAuthenticatedLndGrpc.mockReset());

  it("authenticates over gRPC with the resolved credentials and returns the LND object", () => {
    const lnd = { default: {} } as unknown as AuthenticatedLnd;
    mockedAuthenticatedLndGrpc.mockReturnValue({ lnd });
    expect(connectLnd(connection())).toBe(lnd);
    expect(mockedAuthenticatedLndGrpc).toHaveBeenCalledWith({ cert: CERT_BASE64, macaroon: MACAROON_HEX, socket: HOST });
  });

  it("fails before connecting when a credential is missing", () => {
    expect(() => connectLnd(connection({ macaroonHex: undefined }))).toThrow(/macaroon/);
    expect(mockedAuthenticatedLndGrpc).not.toHaveBeenCalled();
  });
});

describe("disconnectLnd", () => {
  it("closes every gRPC service and skips values that cannot be closed", () => {
    const services = { default: { close: jest.fn() }, invoices: { close: jest.fn() }, router: { close: jest.fn() }, version: "x", empty: null };
    disconnectLnd(services as unknown as AuthenticatedLnd);
    expect(services.default.close).toHaveBeenCalledTimes(1);
    expect(services.invoices.close).toHaveBeenCalledTimes(1);
    expect(services.router.close).toHaveBeenCalledTimes(1);
  });
});
