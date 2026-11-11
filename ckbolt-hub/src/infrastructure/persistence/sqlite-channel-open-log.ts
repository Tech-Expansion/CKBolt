import type Database from "better-sqlite3";
import type { ChannelOpen, ChannelOpenLog } from "../../application/ports/channel-open-log.port";
import type { ChannelOpenKind } from "../../common/constants/channel-opens.constants";
import { CHANNEL_OPEN_LOG_SQL, fromChannelOpenRow, toChannelOpenRow, type ChannelOpenRow } from "./channel-open-log.sql";

/**
 * ChannelOpenLog on SQLite, in the hub's database beside the swaps (the migrations create its table). It does not own
 * the database: whoever opened it closes it (PersistenceModule, through the swap store).
 */
export class SqliteChannelOpenLog implements ChannelOpenLog {
  private readonly insert: Database.Statement<[ChannelOpenRow]>;
  private readonly selectAfter: Database.Statement<[ChannelOpenKind, number], ChannelOpenRow>;
  private readonly deleteBefore: Database.Statement<[number]>;

  /** Takes a migrated database (openHubDatabase). */
  constructor(db: Database.Database) {
    this.insert = db.prepare<[ChannelOpenRow]>(CHANNEL_OPEN_LOG_SQL.insert);
    this.selectAfter = db.prepare<[ChannelOpenKind, number], ChannelOpenRow>(CHANNEL_OPEN_LOG_SQL.selectAfter);
    this.deleteBefore = db.prepare<[number]>(CHANNEL_OPEN_LOG_SQL.deleteBefore);
  }

  record(open: ChannelOpen): void {
    this.insert.run(toChannelOpenRow(open));
  }

  listAfter(kind: ChannelOpenKind, after: number): ChannelOpen[] {
    return this.selectAfter.all(kind, after).map(fromChannelOpenRow);
  }

  forgetBefore(before: number): void {
    this.deleteBefore.run(before);
  }
}
