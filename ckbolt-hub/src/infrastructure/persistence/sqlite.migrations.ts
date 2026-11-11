import { QUOTE_PURPOSE } from "../../common/constants/swap.constants";
import { SQL_FALSE, SQL_TRUE, TABLE } from "./sqlite.constants";

/**
 * One step of the schema. Versions are increasing integers starting at 1. A released migration is never edited or
 * renumbered: change the schema by appending a new one. Migrations run inside the migrator's write transaction, so they
 * cannot change PRAGMAs (e.g. switch foreign keys off for a table rebuild).
 */
export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly sql: string;
}

const booleanColumnCheck = (column: string): string => `CHECK (${column} IN (${SQL_FALSE}, ${SQL_TRUE}))`;

const CREATE_QUOTES = `
  CREATE TABLE ${TABLE.QUOTES} (
    id           TEXT    PRIMARY KEY,
    direction    TEXT    NOT NULL,
    asset        TEXT    NOT NULL,
    sats         TEXT    NOT NULL,
    fiber_amount TEXT    NOT NULL,
    btc_usd      REAL    NOT NULL,
    asset_usd    REAL    NOT NULL,
    price_source TEXT    NOT NULL,
    price_at     INTEGER NOT NULL,
    fee_bps      INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    signature    TEXT    NOT NULL,
    hub_pubkey   TEXT    NOT NULL
  ) STRICT;`;

/**
 * A swap copies every amount and deadline it needs from its quote, so quote_id is not a foreign key: quotes stay
 * short-lived offers that can be pruned without touching swaps.
 */
const CREATE_SWAPS = `
  CREATE TABLE ${TABLE.SWAPS} (
    id                         TEXT    PRIMARY KEY,
    quote_id                   TEXT    NOT NULL,
    direction                  TEXT    NOT NULL,
    asset                      TEXT    NOT NULL,
    payment_hash               TEXT    NOT NULL UNIQUE,
    sats                       TEXT    NOT NULL,
    fiber_amount               TEXT    NOT NULL,
    payout_invoice             TEXT    NOT NULL,
    hold_invoice               TEXT    NOT NULL,
    state                      TEXT    NOT NULL,
    preimage                   TEXT,
    failure_reason             TEXT,
    refunded                   INTEGER NOT NULL ${booleanColumnCheck("refunded")},
    hold_cltv_expiry           INTEGER,
    hold_final_expiry_delta_ms INTEGER,
    payout_lock_limit          INTEGER,
    quote_expires_at           INTEGER NOT NULL,
    demo                       INTEGER NOT NULL ${booleanColumnCheck("demo")},
    created_at                 INTEGER NOT NULL,
    updated_at                 INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ${TABLE.SWAPS}_state_idx ON ${TABLE.SWAPS} (state);`;

/** The integer primary key grows with every insert, so ordering by it gives insertion order. */
const CREATE_SWAP_EVENTS = `
  CREATE TABLE ${TABLE.SWAP_EVENTS} (
    id      INTEGER PRIMARY KEY,
    swap_id TEXT    NOT NULL REFERENCES ${TABLE.SWAPS} (id),
    at      INTEGER NOT NULL,
    type    TEXT    NOT NULL,
    detail  TEXT    NOT NULL
  ) STRICT;
  CREATE INDEX ${TABLE.SWAP_EVENTS}_swap_id_idx ON ${TABLE.SWAP_EVENTS} (swap_id, id);`;

/** One swap per quote: a quote's amounts and liquidity check cover a single payout. */
const UNIQUE_SWAP_PER_QUOTE = `
  CREATE UNIQUE INDEX ${TABLE.SWAPS}_quote_id_idx ON ${TABLE.SWAPS} (quote_id);`;

/**
 * The channels the hub opened on request (inbound Fiber and Lightning channels), for the daily caps on them: rows older
 * than a day count toward no cap and are deleted. pushed_sats is a decimal TEXT, like every amount.
 */
const CREATE_CHANNEL_OPENS = `
  CREATE TABLE ${TABLE.CHANNEL_OPENS} (
    id          INTEGER PRIMARY KEY,
    kind        TEXT    NOT NULL,
    client_key  TEXT    NOT NULL,
    peer        TEXT    NOT NULL,
    pushed_sats TEXT    NOT NULL,
    opened_at   INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ${TABLE.CHANNEL_OPENS}_kind_opened_at_idx ON ${TABLE.CHANNEL_OPENS} (kind, opened_at);`;

/** What each quote is for (QuotePurpose); quotes made before purposes existed were all swap quotes. */
const ADD_QUOTE_PURPOSE = `
  ALTER TABLE ${TABLE.QUOTES} ADD COLUMN purpose TEXT NOT NULL DEFAULT '${QUOTE_PURPOSE.SWAP}';`;

/**
 * The hash of each swap's cancel token. Swaps made before it have none (NULL), so they cannot be cancelled: no token was
 * ever handed out for them.
 */
const ADD_SWAP_CANCEL_TOKEN_HASH = `
  ALTER TABLE ${TABLE.SWAPS} ADD COLUMN cancel_token_hash TEXT;`;

/**
 * The inbound Fiber channels the hub asked its fnn to open, by the temporary id fnn lists each under until its peer
 * accepts: the only pending channels the hub abandons unaccepted. A row is deleted once its channel is abandoned or no
 * longer waits for the peer, so the table holds a handful of rows and needs no index beyond its key.
 */
const CREATE_INBOUND_OPENS = `
  CREATE TABLE ${TABLE.INBOUND_OPENS} (
    temporary_channel_id TEXT    PRIMARY KEY,
    peer                 TEXT    NOT NULL,
    asked_at             INTEGER NOT NULL
  ) STRICT;`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "quotes, swaps and swap events",
    sql: [CREATE_QUOTES, CREATE_SWAPS, CREATE_SWAP_EVENTS].join("\n"),
  },
  {
    version: 2,
    description: "one swap per quote",
    sql: UNIQUE_SWAP_PER_QUOTE,
  },
  {
    version: 3,
    description: "channels opened on request, for their daily caps",
    sql: CREATE_CHANNEL_OPENS,
  },
  {
    version: 4,
    description: "the purpose of each quote (swap or request)",
    sql: ADD_QUOTE_PURPOSE,
  },
  {
    version: 5,
    description: "the hash of each swap's cancel token",
    sql: ADD_SWAP_CANCEL_TOKEN_HASH,
  },
  {
    version: 6,
    description: "inbound Fiber channels the hub asked to open, until their peer accepts",
    sql: CREATE_INBOUND_OPENS,
  },
];
