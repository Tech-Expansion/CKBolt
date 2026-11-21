/**
 * Forgets old quotes (docs/security-review-2026-11.md, H9). Quotes are saved and read through SwapStore; a swap copies
 * every amount and deadline it needs from its quote, so a quote that expired long ago and that no swap uses serves no
 * one. Synchronous (SQLite through better-sqlite3), like SwapStore. Implemented in src/infrastructure/persistence.
 */
export interface QuoteRetention {
  /**
   * Deletes every quote that expired before `expiredBefore` (ms) and that no swap references, in one statement, so a
   * quote a swap uses is never deleted. Returns how many quotes it deleted.
   */
  deleteUnusedQuotesExpiredBefore(expiredBefore: number): number;
}
