/**
 * A one-line reason for logs from anything thrown, with the messages of its causes (fetch hides ECONNREFUSED and the
 * like there). Never send it to users: it can carry internal details. Free of imports, so the devnet scripts use it too.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause === undefined ? error.message : `${error.message}: ${describeError(error.cause)}`;
}
