import type { InboundOpen } from "../../application/ports/inbound-open-store.port";
import { columnsOf, insertSql, selectSql, upsertAssignmentsSql } from "./sql.util";
import { TABLE } from "./sqlite.constants";

/** An inbound open as SQLite stores it: the time as INTEGER ms. */
export interface InboundOpenRow {
  temporary_channel_id: string;
  peer: string;
  asked_at: number;
}

/** The parameters of a listing: `peer` null lists the opens to every peer. */
export interface InboundOpenListParams {
  asked_by: number;
  peer: string | null;
}

export const INBOUND_OPEN_COLUMNS = columnsOf<InboundOpenRow>({
  temporary_channel_id: true,
  peer: true,
  asked_at: true,
});

const INBOUND_OPEN_UPDATABLE_COLUMNS = INBOUND_OPEN_COLUMNS.filter((column) => column !== "temporary_channel_id");

export const toInboundOpenRow = (open: InboundOpen): InboundOpenRow => ({
  temporary_channel_id: open.temporaryChannelId,
  peer: open.peer,
  asked_at: open.askedAt,
});

export const fromInboundOpenRow = (row: InboundOpenRow): InboundOpen => ({
  temporaryChannelId: row.temporary_channel_id,
  peer: row.peer,
  askedAt: row.asked_at,
});

/** Every statement of the inbound open store, prepared once. Recording an id again replaces its row, like a Map.set. */
export const INBOUND_OPEN_STORE_SQL = {
  upsert: `${insertSql(TABLE.INBOUND_OPENS, INBOUND_OPEN_COLUMNS)} ON CONFLICT (temporary_channel_id) DO UPDATE SET ${upsertAssignmentsSql(INBOUND_OPEN_UPDATABLE_COLUMNS)}`,
  selectAskedBy: `${selectSql(TABLE.INBOUND_OPENS, INBOUND_OPEN_COLUMNS)} WHERE asked_at <= @asked_by AND (@peer IS NULL OR peer = @peer) ORDER BY asked_at, temporary_channel_id`,
  delete: `DELETE FROM ${TABLE.INBOUND_OPENS} WHERE temporary_channel_id = ?`,
} as const;
