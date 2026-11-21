import { TABLE } from "./sqlite.constants";

/**
 * The statement of the quote retention, prepared once. A swap names its quote in quote_id (unique, indexed), so the
 * NOT EXISTS check keeps every quote a swap uses whatever its age.
 */
export const QUOTE_RETENTION_SQL = {
  deleteUnusedExpiredBefore: `DELETE FROM ${TABLE.QUOTES}
    WHERE expires_at < ?
      AND NOT EXISTS (SELECT 1 FROM ${TABLE.SWAPS} WHERE ${TABLE.SWAPS}.quote_id = ${TABLE.QUOTES}.id)`,
} as const;
