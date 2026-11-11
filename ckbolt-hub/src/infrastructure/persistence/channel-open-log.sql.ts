import type { ChannelOpen } from "../../application/ports/channel-open-log.port";
import type { ChannelOpenKind } from "../../common/constants/channel-opens.constants";
import { fromDecimalString, toDecimalString } from "../../common/utils/amount.util";
import { columnsOf, insertSql, selectSql } from "./sql.util";
import { TABLE } from "./sqlite.constants";

/** A channel open as SQLite stores it: the pushed sats as decimal TEXT, the time as INTEGER ms. */
export interface ChannelOpenRow {
  kind: ChannelOpenKind;
  client_key: string;
  peer: string;
  pushed_sats: string;
  opened_at: number;
}

export const CHANNEL_OPEN_COLUMNS = columnsOf<ChannelOpenRow>({
  kind: true,
  client_key: true,
  peer: true,
  pushed_sats: true,
  opened_at: true,
});

export const toChannelOpenRow = (open: ChannelOpen): ChannelOpenRow => ({
  kind: open.kind,
  client_key: open.clientKey,
  peer: open.peer,
  pushed_sats: toDecimalString(open.pushedSats),
  opened_at: open.openedAt,
});

export const fromChannelOpenRow = (row: ChannelOpenRow): ChannelOpen => ({
  kind: row.kind,
  clientKey: row.client_key,
  peer: row.peer,
  pushedSats: fromDecimalString(row.pushed_sats),
  openedAt: row.opened_at,
});

/** Every statement of the channel open log, prepared once. Insertion order breaks ties between opens of one instant. */
export const CHANNEL_OPEN_LOG_SQL = {
  insert: insertSql(TABLE.CHANNEL_OPENS, CHANNEL_OPEN_COLUMNS),
  selectAfter: `${selectSql(TABLE.CHANNEL_OPENS, CHANNEL_OPEN_COLUMNS)} WHERE kind = ? AND opened_at > ? ORDER BY opened_at, id`,
  deleteBefore: `DELETE FROM ${TABLE.CHANNEL_OPENS} WHERE opened_at < ?`,
} as const;
