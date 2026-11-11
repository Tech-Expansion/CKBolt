/** Facts the live check compares the running devnet against (the devnet spec in docs/phase-3-plan.md section 4). */

/** Versions pinned by the plan. */
export const EXPECTED_VERSION = {
  BITCOIN_CORE: "29.4",
  LND: "0.21.4-beta",
  CKB: "0.202.0",
  FNN: "0.9.1",
} as const;

/** The block producer, which docker-compose.yml runs next to the SERVICE nodes. */
export const CKB_MINER_SERVICE = "ckb-miner";

/** Host address every published port must bind to. */
export const LOOPBACK = "127.0.0.1";

/** Docker's container states and health values in `docker compose ps --format json`. */
export const CONTAINER_RUNNING = "running";
export const CONTAINER_HEALTHY = "healthy";

/** How long the CKB tip gets to move forward (ckb-miner makes a block every CKB_BLOCK_INTERVAL_MS). */
export const CKB_TIP_WAIT_MS = 10_000;

/** Contracts devnet/ckb/dev.toml puts in genesis (files in devnet/ckb/contracts). */
export const GENESIS_CONTRACT_FILES = ["auth", "funding-lock", "commitment-lock", "simple_udt", "xudt_rce"] as const;

/** Files the bootstrap copies out of each LND container, and the macaroon the hub side uses there. */
export const LND_SECRET_FILES = { "lnd-hub": ["tls.cert", "admin.macaroon", "hub.macaroon"], "lnd-user": ["tls.cert", "admin.macaroon", "demo.macaroon"] } as const;

/** lnrpc.Invoice.InvoiceState / lnrpc.Payment.PaymentStatus values, as lncli prints them. */
export const LND_STATE = { ACCEPTED: "ACCEPTED", CANCELED: "CANCELED", FAILED: "FAILED" } as const;

/** fnn v0.9.1 invoice and payment statuses the refund checks wait for. */
export const FNN_STATE = { RECEIVED: "Received", CANCELLED: "Cancelled", FAILED: "Failed" } as const;

/** Description written on the check's own invoices, so they are easy to tell apart in the node logs. */
export const CHECK_INVOICE_DESCRIPTION = "ckbolt devnet check";

/** Expiry of the check's own invoices: long enough for a slow machine, short enough to vanish soon. */
export const CHECK_INVOICE_EXPIRY_SECONDS = 600;

/** One minute below fnn's release minimum final_expiry_delta: a release build must refuse it. */
export const BELOW_MINIMUM_MARGIN_MS = 60_000;
