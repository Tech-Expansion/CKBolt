/** fiber-js rejects with strings such as `ErrorObject { code: ServerError(-32000), message: "Peer not found" }`. */
const RPC_MESSAGE = /message:\s*"((?:[^"\\]|\\.)*)"/;

const GENERIC = "The Fiber node reported an error.";

/** The text of a thrown string, Error, or worker ErrorEvent (anything with a string `message`). */
function errorText(error: unknown): string | null {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return null;
}

/** A readable sentence from whatever fiber-js (or one of its workers) threw. */
export function fiberErrorMessage(error: unknown): string {
  const text = errorText(error);
  if (!text) return GENERIC;
  const match = RPC_MESSAGE.exec(text);
  return (match ? match[1].replace(/\\"/g, '"') : text).trim() || GENERIC;
}
