/** Values of the health check (src/application/health). How long a node gets to answer is HubConfig.health.timeoutMs. */

export const HEALTH_STATUS = { OK: "ok", DEGRADED: "degraded" } as const;

/** A degraded report's reason is one plain sentence per problem, joined by this. */
export const HEALTH_REASON_SEPARATOR = " ";

/** The npm manifest the hub's version is read from, found by walking up from the running file. */
export const PACKAGE_MANIFEST_FILE = "package.json";
/** Reported when no manifest with a version is found. */
export const UNKNOWN_VERSION = "unknown";
