/** Table names, shared by the migrations and the queries so the two cannot drift apart. */
export const TABLE = {
  SCHEMA_VERSION: "schema_version",
  QUOTES: "quotes",
  SWAPS: "swaps",
  SWAP_EVENTS: "swap_events",
  CHANNEL_OPENS: "channel_opens",
  INBOUND_OPENS: "inbound_opens",
} as const;

/** Schema version of a database no migration has touched yet. Migration versions start above it. */
export const EMPTY_SCHEMA_VERSION = 0;

/**
 * Applied on every connection. WAL lets reads run beside the writer. FULL syncs every commit to disk: the engine saves a
 * transition (or a preimage) before it acts on it, so a commit must survive a power cut, not only a process crash.
 */
export const SQLITE_PRAGMAS: readonly string[] = ["journal_mode = WAL", "foreign_keys = ON", "synchronous = FULL"];

/** SQLite has no boolean type: booleans are stored as these integers. */
export const SQL_TRUE = 1;
export const SQL_FALSE = 0;

/** `SqliteError.code` values the store turns into domain errors. */
export const SQLITE_ERROR_CODE = {
  UNIQUE: "SQLITE_CONSTRAINT_UNIQUE",
  FOREIGN_KEY: "SQLITE_CONSTRAINT_FOREIGNKEY",
} as const;

/** Unique columns of the swaps table, as SQLite names them in "UNIQUE constraint failed: <table>.<column>". */
export const SWAP_UNIQUE_COLUMN = {
  PAYMENT_HASH: `${TABLE.SWAPS}.payment_hash`,
  QUOTE_ID: `${TABLE.SWAPS}.quote_id`,
} as const;
