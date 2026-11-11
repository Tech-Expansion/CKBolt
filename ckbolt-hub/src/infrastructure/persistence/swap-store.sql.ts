import { OPEN_SWAP_STATES, SWAP_STATE } from "../../common/constants/swap.constants";
import type { SwapState } from "../../domain/types";
import { assignmentsSql, insertSql, positionalParameters, selectSql, upsertAssignmentsSql } from "./sql.util";
import { SQL_FALSE, TABLE } from "./sqlite.constants";
import { QUOTE_COLUMNS, SWAP_COLUMNS, SWAP_EVENT_COLUMNS, type SwapRow } from "./swap-store.rows";

/** Named parameter holding the state a compare-and-set update expects the swap to be in. */
export const EXPECTED_STATE_PARAM = "expected_state";

export type CompareAndSetSwapRow = SwapRow & { [EXPECTED_STATE_PARAM]: SwapState };

/** A quote can be rewritten whole; a swap never changes its identity, creation time or cancel token's hash. */
const QUOTE_UPDATABLE_COLUMNS = QUOTE_COLUMNS.filter((column) => column !== "id");
const SWAP_FIXED_COLUMNS: readonly (typeof SWAP_COLUMNS)[number][] = ["id", "created_at", "cancel_token_hash"];
const SWAP_UPDATABLE_COLUMNS = SWAP_COLUMNS.filter((column) => !SWAP_FIXED_COLUMNS.includes(column));

const SELECT_SWAPS = selectSql(TABLE.SWAPS, SWAP_COLUMNS);
const UPDATE_SWAP = `UPDATE ${TABLE.SWAPS} SET ${assignmentsSql(SWAP_UPDATABLE_COLUMNS)} WHERE id = @id`;

/** Every statement of the store, prepared once when the store opens. */
export const SWAP_STORE_SQL = {
  upsertQuote: `${insertSql(TABLE.QUOTES, QUOTE_COLUMNS)} ON CONFLICT (id) DO UPDATE SET ${upsertAssignmentsSql(QUOTE_UPDATABLE_COLUMNS)}`,
  selectQuoteById: `${selectSql(TABLE.QUOTES, QUOTE_COLUMNS)} WHERE id = ?`,

  insertSwap: insertSql(TABLE.SWAPS, SWAP_COLUMNS),
  selectSwapById: `${SELECT_SWAPS} WHERE id = ?`,
  selectSwapByHash: `${SELECT_SWAPS} WHERE payment_hash = ?`,
  selectSwapByQuoteId: `${SELECT_SWAPS} WHERE quote_id = ?`,
  /** Open states, plus failed swaps not yet refunded; oldest first, insertion order breaking ties. */
  selectOpenSwaps: `${SELECT_SWAPS}
    WHERE state IN (${positionalParameters(OPEN_SWAP_STATES.length)}) OR (state = ? AND refunded = ?)
    ORDER BY created_at, rowid`,
  updateSwap: UPDATE_SWAP,
  updateSwapIfInState: `${UPDATE_SWAP} AND state = @${EXPECTED_STATE_PARAM}`,

  insertEvent: insertSql(TABLE.SWAP_EVENTS, SWAP_EVENT_COLUMNS),
  selectEventsBySwap: `${selectSql(TABLE.SWAP_EVENTS, SWAP_EVENT_COLUMNS)} WHERE swap_id = ? ORDER BY id`,
} as const;

/**
 * Values for the positional parameters of `selectOpenSwaps`, in order. A failed swap stays open until its incoming leg
 * is cancelled (refunded = false), so the engine can finish the refund.
 */
export const OPEN_SWAPS_PARAMS: readonly (SwapState | number)[] = [...OPEN_SWAP_STATES, SWAP_STATE.FAILED, SQL_FALSE];
