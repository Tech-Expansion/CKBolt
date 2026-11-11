import { HttpStatus } from "@nestjs/common";
import { API_ERROR_CODE } from "../../common/constants/api.constants";
import {
  GRPC_ACCESS_DENIED_CODES,
  GRPC_STATUS,
  GRPC_TRANSPORT_FAILURE_CODES,
  LIGHTNING_LIB_ERROR,
  LIGHTNING_LIB_NODE_UNAVAILABLE_ERRORS,
  LND_ERROR_DETAILS,
} from "../../common/constants/lnd.constants";
import { BOLT11_PREFIXES } from "../../common/constants/protocol.constants";
import { HubError } from "../../common/errors/hub.error";
import type { BtcNetwork } from "../../domain/types";

/**
 * Errors of the LND adapter.
 * - LndUnavailableError: the node cannot serve calls (unreachable, locked), or the call may or may not have reached LND
 *   (connection lost, deadline). Re-read state before acting.
 * - LndRpcError: LND (or the `lightning` package) answered with an error the hub did not expect.
 * - LnInvoiceInvalidError / LnInvoiceWrongNetworkError: a user-supplied BOLT11 invoice the hub cannot use.
 */

/** What the hub reads from an error of the `lightning` package: a `[code, name, { err }]` array or a thrown Error. */
export interface LndErrorInfo {
  /** The package's error name (e.g. "UnexpectedLookupInvoiceErr"), or the message of a thrown Error. */
  name: string;
  /** gRPC status code of LND's answer; null when the error did not come from a gRPC call. */
  grpcCode: number | null;
  /** LND's own error text (e.g. "unable to locate invoice"); empty when there is none. */
  details: string;
}

type GrpcErrorFields = { code?: unknown; details?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function fromGrpcFields(name: string, fields: GrpcErrorFields): LndErrorInfo {
  return {
    name,
    grpcCode: typeof fields.code === "number" ? fields.code : null,
    details: typeof fields.details === "string" ? fields.details : "",
  };
}

/** The package rejects with `[httpLikeCode, errorName, { err: grpcError }]`. */
function fromLibraryArray([, name, extra]: unknown[]): LndErrorInfo {
  const grpcError = isRecord(extra) && isRecord(extra.err) ? extra.err : {};
  return fromGrpcFields(String(name), grpcError);
}

export function readLndError(error: unknown): LndErrorInfo {
  if (Array.isArray(error)) return fromLibraryArray(error);
  if (error instanceof Error) return fromGrpcFields(error.message, error as GrpcErrorFields);
  return { name: String(error), grpcCode: null, details: "" };
}

const hasGrpcCode = (info: LndErrorInfo, codes: readonly number[]): boolean => info.grpcCode !== null && codes.includes(info.grpcCode);

export const hasLndDetails = (info: LndErrorInfo, text: string): boolean => info.details.includes(text);

export const isTransportFailure = (info: LndErrorInfo): boolean => hasGrpcCode(info, GRPC_TRANSPORT_FAILURE_CODES);

/** The node cannot serve calls right now: a transport failure, or the package reporting it unreachable or locked. */
export const isNodeUnavailable = (info: LndErrorInfo): boolean =>
  isTransportFailure(info) || LIGHTNING_LIB_NODE_UNAVAILABLE_ERRORS.includes(info.name);

export const isAccessDenied = (info: LndErrorInfo): boolean =>
  hasGrpcCode(info, GRPC_ACCESS_DENIED_CODES) || hasLndDetails(info, LND_ERROR_DETAILS.PERMISSION_DENIED);

export const isInvoiceNotFound = (info: LndErrorInfo): boolean =>
  info.grpcCode === GRPC_STATUS.NOT_FOUND ||
  hasLndDetails(info, LND_ERROR_DETAILS.INVOICE_NOT_FOUND) ||
  hasLndDetails(info, LND_ERROR_DETAILS.NO_INVOICES_YET);

export const isPaymentNotFound = (info: LndErrorInfo): boolean =>
  info.name === LIGHTNING_LIB_ERROR.PAYMENT_NOT_FOUND || info.grpcCode === GRPC_STATUS.NOT_FOUND;

const describeLndError = (info: LndErrorInfo): string => info.details || info.name;

export class LndUnavailableError extends HubError {
  constructor(
    readonly rpc: string,
    readonly info: LndErrorInfo,
  ) {
    super(`The Lightning node is unavailable (${rpc}). Try again in a moment.`, HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
    this.name = "LndUnavailableError";
  }
}

export class LndRpcError extends Error {
  constructor(
    readonly rpc: string,
    readonly info: LndErrorInfo,
  ) {
    super(`LND ${rpc} failed: ${describeLndError(info)}`);
    this.name = "LndRpcError";
  }
}

export class LnInvoiceInvalidError extends HubError {
  constructor(readonly detail: string) {
    super(`This Lightning invoice cannot be read (${detail}). Check that it is a complete BOLT11 invoice.`, HttpStatus.BAD_REQUEST, API_ERROR_CODE.INVOICE_INVALID);
    this.name = "LnInvoiceInvalidError";
  }

  static unknownPrefix(): LnInvoiceInvalidError {
    const prefixes = BOLT11_PREFIXES.map(({ prefix }) => prefix).join(", ");
    return new LnInvoiceInvalidError(`it does not start with one of ${prefixes}`);
  }
}

export class LnInvoiceWrongNetworkError extends HubError {
  constructor(
    readonly invoiceNetwork: BtcNetwork,
    readonly nodeNetwork: BtcNetwork,
  ) {
    super(
      `This Lightning invoice is for ${invoiceNetwork}, but the hub runs on ${nodeNetwork}. Use a ${nodeNetwork} invoice.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      API_ERROR_CODE.INVOICE_INVALID,
    );
    this.name = "LnInvoiceWrongNetworkError";
  }
}

/** The error to throw for a failed call: errors the adapter already raised pass through; an unavailable node says so. */
export function toLndError(rpc: string, error: unknown): Error {
  if (error instanceof HubError || error instanceof LndRpcError) return error;
  const info = readLndError(error);
  return isNodeUnavailable(info) ? new LndUnavailableError(rpc, info) : new LndRpcError(rpc, info);
}
