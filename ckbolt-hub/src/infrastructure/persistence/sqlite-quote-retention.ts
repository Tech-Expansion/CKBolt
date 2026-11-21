import type Database from "better-sqlite3";
import type { QuoteRetention } from "../../application/ports/quote-retention.port";
import { QUOTE_RETENTION_SQL } from "./quote-retention.sql";

/**
 * QuoteRetention on SQLite, in the hub's database beside the swaps. It does not own the database: whoever opened it
 * closes it (PersistenceModule, through the swap store).
 */
export class SqliteQuoteRetention implements QuoteRetention {
  private readonly deleteUnusedExpiredBefore: Database.Statement<[number]>;

  /** Takes a migrated database (openHubDatabase). */
  constructor(db: Database.Database) {
    this.deleteUnusedExpiredBefore = db.prepare<[number]>(QUOTE_RETENTION_SQL.deleteUnusedExpiredBefore);
  }

  deleteUnusedQuotesExpiredBefore(expiredBefore: number): number {
    return this.deleteUnusedExpiredBefore.run(expiredBefore).changes;
  }
}
