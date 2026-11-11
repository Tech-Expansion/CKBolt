import type Database from "better-sqlite3";
import type { Clock } from "../../application/ports/clock.port";
import type { SwapStore, SwapTransitionPatch, SwapUpdatePatch } from "../../application/ports/swap-store.port";
import { RESOURCE_NAME } from "../../common/constants/api.constants";
import { DuplicateHashError, NotFoundError, QuoteAlreadyUsedError, type HubError } from "../../common/errors/hub.error";
import type { Hex32, Quote, Swap, SwapEvent, SwapState } from "../../domain/types";
import { SQLITE_ERROR_CODE, SWAP_UNIQUE_COLUMN } from "./sqlite.constants";
import { isSqliteError, openHubDatabase } from "./sqlite.database";
import {
  fromQuoteRow,
  fromSwapEventRow,
  fromSwapRow,
  toQuoteRow,
  toSwapEventRow,
  toSwapRow,
  type QuoteRow,
  type SwapEventRow,
  type SwapRow,
} from "./swap-store.rows";
import { EXPECTED_STATE_PARAM, OPEN_SWAPS_PARAMS, SWAP_STORE_SQL, type CompareAndSetSwapRow } from "./swap-store.sql";

/** What a UNIQUE violation on each swaps column means for the caller. */
const SWAP_UNIQUE_VIOLATION: Readonly<Record<string, () => HubError>> = {
  [SWAP_UNIQUE_COLUMN.PAYMENT_HASH]: () => new DuplicateHashError(),
  [SWAP_UNIQUE_COLUMN.QUOTE_ID]: () => new QuoteAlreadyUsedError(),
};

/** The domain error for a UNIQUE violation SQLite reports as "UNIQUE constraint failed: swaps.<column>"; null otherwise. */
function uniqueViolationError(error: unknown): HubError | null {
  if (!isSqliteError(error, SQLITE_ERROR_CODE.UNIQUE)) return null;
  const column = Object.keys(SWAP_UNIQUE_VIOLATION).find((name) => error.message.includes(name));
  const toError = column === undefined ? undefined : SWAP_UNIQUE_VIOLATION[column];
  return toError ? toError() : null;
}

interface Statements {
  upsertQuote: Database.Statement<[QuoteRow]>;
  selectQuoteById: Database.Statement<[string], QuoteRow>;
  insertSwap: Database.Statement<[SwapRow]>;
  selectSwapById: Database.Statement<[string], SwapRow>;
  selectSwapByHash: Database.Statement<[Hex32], SwapRow>;
  selectSwapByQuoteId: Database.Statement<[string], SwapRow>;
  selectOpenSwaps: Database.Statement<(SwapState | number)[], SwapRow>;
  updateSwap: Database.Statement<[SwapRow]>;
  updateSwapIfInState: Database.Statement<[CompareAndSetSwapRow]>;
  insertEvent: Database.Statement<[SwapEventRow]>;
  selectEventsBySwap: Database.Statement<[string], SwapEventRow>;
}

const prepareStatements = (db: Database.Database): Statements => ({
  upsertQuote: db.prepare<[QuoteRow]>(SWAP_STORE_SQL.upsertQuote),
  selectQuoteById: db.prepare<[string], QuoteRow>(SWAP_STORE_SQL.selectQuoteById),
  insertSwap: db.prepare<[SwapRow]>(SWAP_STORE_SQL.insertSwap),
  selectSwapById: db.prepare<[string], SwapRow>(SWAP_STORE_SQL.selectSwapById),
  selectSwapByHash: db.prepare<[Hex32], SwapRow>(SWAP_STORE_SQL.selectSwapByHash),
  selectSwapByQuoteId: db.prepare<[string], SwapRow>(SWAP_STORE_SQL.selectSwapByQuoteId),
  selectOpenSwaps: db.prepare<(SwapState | number)[], SwapRow>(SWAP_STORE_SQL.selectOpenSwaps),
  updateSwap: db.prepare<[SwapRow]>(SWAP_STORE_SQL.updateSwap),
  updateSwapIfInState: db.prepare<[CompareAndSetSwapRow]>(SWAP_STORE_SQL.updateSwapIfInState),
  insertEvent: db.prepare<[SwapEventRow]>(SWAP_STORE_SQL.insertEvent),
  selectEventsBySwap: db.prepare<[string], SwapEventRow>(SWAP_STORE_SQL.selectEventsBySwap),
});

/** The patch's defined fields only: a field given as undefined keeps its stored value. */
const definedFields = <T extends object>(patch: T): Partial<T> =>
  Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;

/** `current` with `patch` applied; identity, creation time and cancel token's hash never change, updatedAt is set to `now`. */
const applyPatch = (current: Swap, patch: SwapTransitionPatch, now: number): Swap => ({
  ...current,
  ...definedFields(patch),
  id: current.id,
  createdAt: current.createdAt,
  cancelTokenHash: current.cancelTokenHash,
  updatedAt: now,
});

/**
 * SwapStore on SQLite (better-sqlite3, synchronous). Statements are prepared once; every read-modify-write runs in an
 * IMMEDIATE transaction, so it holds the write lock from its first read and cannot interleave with another writer.
 */
export class SqliteSwapStore implements SwapStore {
  private readonly statements: Statements;
  private readonly transitionAtomically: Database.Transaction<(id: string, from: SwapState, patch: SwapTransitionPatch) => Swap | null>;
  private readonly updateAtomically: Database.Transaction<(id: string, patch: SwapUpdatePatch) => Swap>;

  /** Takes a migrated database (see openSqliteSwapStore) and owns it from then on: close() closes it. */
  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
  ) {
    this.statements = prepareStatements(db);
    this.transitionAtomically = db.transaction((id: string, from: SwapState, patch: SwapTransitionPatch) =>
      this.compareAndSet(id, from, patch),
    );
    this.updateAtomically = db.transaction((id: string, patch: SwapUpdatePatch) => this.overwrite(id, patch));
  }

  saveQuote(quote: Quote): void {
    this.statements.upsertQuote.run(toQuoteRow(quote));
  }

  getQuote(id: string): Quote | null {
    const row = this.statements.selectQuoteById.get(id);
    return row ? fromQuoteRow(row) : null;
  }

  createSwap(swap: Swap): void {
    try {
      this.statements.insertSwap.run(toSwapRow(swap));
    } catch (error) {
      // payment_hash and quote_id are the UNIQUE columns of the swaps table (a duplicate id is a PRIMARYKEY violation).
      throw uniqueViolationError(error) ?? error;
    }
  }

  getSwap(id: string): Swap | null {
    const row = this.statements.selectSwapById.get(id);
    return row ? fromSwapRow(row) : null;
  }

  getSwapByHash(paymentHash: Hex32): Swap | null {
    const row = this.statements.selectSwapByHash.get(paymentHash);
    return row ? fromSwapRow(row) : null;
  }

  getSwapByQuoteId(quoteId: string): Swap | null {
    const row = this.statements.selectSwapByQuoteId.get(quoteId);
    return row ? fromSwapRow(row) : null;
  }

  listOpenSwaps(): Swap[] {
    return this.statements.selectOpenSwaps.all(...OPEN_SWAPS_PARAMS).map(fromSwapRow);
  }

  transition(id: string, from: SwapState, patch: SwapTransitionPatch): Swap | null {
    return this.transitionAtomically.immediate(id, from, patch);
  }

  update(id: string, patch: SwapUpdatePatch): Swap {
    return this.updateAtomically.immediate(id, patch);
  }

  addEvent(event: SwapEvent): void {
    try {
      this.statements.insertEvent.run(toSwapEventRow(event));
    } catch (error) {
      if (isSqliteError(error, SQLITE_ERROR_CODE.FOREIGN_KEY)) throw new NotFoundError(RESOURCE_NAME.SWAP);
      throw error;
    }
  }

  listEvents(swapId: string): SwapEvent[] {
    return this.statements.selectEventsBySwap.all(swapId).map(fromSwapEventRow);
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  /** The UPDATE itself checks the state, so the database stays the single judge of whether the transition wins. */
  private compareAndSet(id: string, from: SwapState, patch: SwapTransitionPatch): Swap | null {
    const current = this.getSwap(id);
    if (!current) return null;
    const next = applyPatch(current, patch, this.clock.now());
    const { changes } = this.statements.updateSwapIfInState.run({ ...toSwapRow(next), [EXPECTED_STATE_PARAM]: from });
    return changes > 0 ? next : null;
  }

  private overwrite(id: string, patch: SwapUpdatePatch): Swap {
    const current = this.getSwap(id);
    if (!current) throw new NotFoundError(RESOURCE_NAME.SWAP);
    const next: Swap = { ...applyPatch(current, patch, this.clock.now()), state: current.state };
    this.statements.updateSwap.run(toSwapRow(next));
    return next;
  }
}

/**
 * Opens (or creates) the database at `path`, applies pending migrations and returns the store. SQLITE_IN_MEMORY_PATH
 * gives a private in-memory store, e.g. for tests.
 */
export function openSqliteSwapStore(path: string, clock: Clock): SqliteSwapStore {
  return new SqliteSwapStore(openHubDatabase(path, clock), clock);
}
