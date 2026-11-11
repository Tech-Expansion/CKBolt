import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import type Database from "better-sqlite3";
import type { ChannelOpenLog } from "../../application/ports/channel-open-log.port";
import type { Clock } from "../../application/ports/clock.port";
import type { InboundOpenStore } from "../../application/ports/inbound-open-store.port";
import type { SwapStore } from "../../application/ports/swap-store.port";
import { CHANNEL_OPEN_LOG, CLOCK, HUB_CONFIG, INBOUND_OPEN_STORE, SWAP_STORE } from "../../application/ports/tokens";
import type { HubConfig } from "../../config/hub.config";
import { SqliteChannelOpenLog } from "./sqlite-channel-open-log";
import { openHubDatabase } from "./sqlite.database";
import { SqliteInboundOpenStore } from "./sqlite-inbound-open-store";
import { SqliteSwapStore } from "./sqlite-swap-store";

/** The hub's one database connection, shared by the stores below; not exported. */
const HUB_DATABASE = Symbol("HUB_DATABASE");

/**
 * Provides SWAP_STORE, CHANNEL_OPEN_LOG and INBOUND_OPEN_STORE (SQLite at `config.database.path`, one database for all)
 * to every module.
 * The database closes on application shutdown, the last lifecycle step: after every module's onModuleDestroy (the swap
 * scheduler stops there) and after the HTTP server has closed, so nothing that is still running finds it closed.
 */
@Global()
@Module({
  providers: [
    {
      provide: HUB_DATABASE,
      useFactory: (config: HubConfig, clock: Clock): Database.Database => openHubDatabase(config.database.path, clock),
      inject: [HUB_CONFIG, CLOCK],
    },
    {
      provide: SWAP_STORE,
      useFactory: (db: Database.Database, clock: Clock): SwapStore => new SqliteSwapStore(db, clock),
      inject: [HUB_DATABASE, CLOCK],
    },
    {
      provide: CHANNEL_OPEN_LOG,
      useFactory: (db: Database.Database): ChannelOpenLog => new SqliteChannelOpenLog(db),
      inject: [HUB_DATABASE],
    },
    {
      provide: INBOUND_OPEN_STORE,
      useFactory: (db: Database.Database): InboundOpenStore => new SqliteInboundOpenStore(db),
      inject: [HUB_DATABASE],
    },
  ],
  exports: [SWAP_STORE, CHANNEL_OPEN_LOG, INBOUND_OPEN_STORE],
})
export class PersistenceModule implements OnApplicationShutdown {
  constructor(@Inject(SWAP_STORE) private readonly store: SwapStore) {}

  /** The swap store owns the shared connection: closing it closes the database for the other stores too. */
  onApplicationShutdown(): void {
    this.store.close();
  }
}
