/**
 * Storage facts shared by the persistence adapter, its tests and deployment docs. Where the database lives is a tunable
 * (HUB_DB_PATH); these values are not.
 */

/** A database path that keeps everything in memory: nothing is written to disk and the data dies with the process. */
export const SQLITE_IN_MEMORY_PATH = ":memory:";
