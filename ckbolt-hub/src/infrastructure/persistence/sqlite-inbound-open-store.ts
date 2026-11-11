import type Database from "better-sqlite3";
import type { InboundOpen, InboundOpenStore } from "../../application/ports/inbound-open-store.port";
import {
  fromInboundOpenRow,
  INBOUND_OPEN_STORE_SQL,
  toInboundOpenRow,
  type InboundOpenListParams,
  type InboundOpenRow,
} from "./inbound-open-store.sql";

/**
 * InboundOpenStore on SQLite, in the hub's database beside the swaps (the migrations create its table). It does not own
 * the database: whoever opened it closes it (PersistenceModule, through the swap store).
 */
export class SqliteInboundOpenStore implements InboundOpenStore {
  private readonly upsert: Database.Statement<[InboundOpenRow]>;
  private readonly selectAskedBy: Database.Statement<[InboundOpenListParams], InboundOpenRow>;
  private readonly delete: Database.Statement<[string]>;

  /** Takes a migrated database (openHubDatabase). */
  constructor(db: Database.Database) {
    this.upsert = db.prepare<[InboundOpenRow]>(INBOUND_OPEN_STORE_SQL.upsert);
    this.selectAskedBy = db.prepare<[InboundOpenListParams], InboundOpenRow>(INBOUND_OPEN_STORE_SQL.selectAskedBy);
    this.delete = db.prepare<[string]>(INBOUND_OPEN_STORE_SQL.delete);
  }

  record(open: InboundOpen): void {
    this.upsert.run(toInboundOpenRow(open));
  }

  listAskedBy(askedBy: number, peer?: string): InboundOpen[] {
    return this.selectAskedBy.all({ asked_by: askedBy, peer: peer ?? null }).map(fromInboundOpenRow);
  }

  forget(temporaryChannelId: string): void {
    this.delete.run(temporaryChannelId);
  }
}
