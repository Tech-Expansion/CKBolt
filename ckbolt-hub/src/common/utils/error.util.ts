/** An error's log-only `detail` text (HubError's, for one), set apart from its message; empty when it has none. */
function detailOf(error: Error): string {
  const { detail } = error as { detail?: unknown };
  return typeof detail === "string" && detail !== "" ? ` [${detail}]` : "";
}

/**
 * A one-line reason for logs from anything thrown, with its log-only detail (a node's own error text, which a HubError
 * keeps out of its message), the messages of its causes (fetch hides ECONNREFUSED and the like there) and of every
 * error an AggregateError groups. Never send it to users: it can carry internal details. Free of imports, so the devnet
 * scripts use it too.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const grouped = error instanceof AggregateError && error.errors.length > 0 ? ` (${error.errors.map(describeError).join("; ")})` : "";
  const message = `${error.message}${detailOf(error)}${grouped}`;
  return error.cause === undefined ? message : `${message}: ${describeError(error.cause)}`;
}
