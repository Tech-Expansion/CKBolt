import { readFileSync } from "node:fs";
import { authenticatedLndGrpc, type AuthenticatedLnd } from "lightning";
import type { LndConnection } from "../../config/hub.config";

/** Reads a credential file; injectable so tests need no files. */
export type CredentialFileReader = (path: string) => Buffer;

/** What `authenticatedLndGrpc` needs: the TLS certificate as base64 of the PEM, the macaroon as hex, and host:port. */
export interface LndGrpcAuth {
  cert: string;
  macaroon: string;
  socket: string;
}

interface CredentialKind {
  name: string;
  /** How the file's bytes are written as the string `authenticatedLndGrpc` takes. */
  encoding: BufferEncoding;
}

interface CredentialSource {
  inline?: string;
  path?: string;
}

const TLS_CERT: CredentialKind = { name: "TLS certificate", encoding: "base64" };
const MACAROON: CredentialKind = { name: "macaroon", encoding: "hex" };

function requireCredential(kind: CredentialKind, source: CredentialSource, host: string, readFile: CredentialFileReader): string {
  const inline = source.inline?.trim();
  if (inline) return inline;
  if (source.path) return readFile(source.path).toString(kind.encoding);
  throw new Error(`LND at ${host} needs a ${kind.name}: set it inline or give its file path.`);
}

/** Resolves the certificate and macaroon of a connection from inline values or files. Throws when one is missing. */
export function lndGrpcAuth(connection: LndConnection, readFile: CredentialFileReader = readFileSync): LndGrpcAuth {
  const host = connection.grpcHost;
  return {
    cert: requireCredential(TLS_CERT, { inline: connection.tlsCertBase64, path: connection.tlsCertPath }, host, readFile),
    macaroon: requireCredential(MACAROON, { inline: connection.macaroonHex, path: connection.macaroonPath }, host, readFile),
    socket: host,
  };
}

/** gRPC clients for every LND service. Nothing is sent until the first call. */
export const connectLnd = (connection: LndConnection, readFile?: CredentialFileReader): AuthenticatedLnd =>
  authenticatedLndGrpc(lndGrpcAuth(connection, readFile)).lnd;

type Closable = { close(): void };

const isClosable = (service: unknown): service is Closable =>
  typeof service === "object" && service !== null && typeof (service as Partial<Closable>).close === "function";

/** Closes the gRPC channels so the process can exit. */
export function disconnectLnd(lnd: AuthenticatedLnd): void {
  for (const service of Object.values(lnd)) if (isClosable(service)) service.close();
}
