/**
 * Facts of fnn v0.9.1's config.yml that the whitelist generator (src/interfaces/cli/fnn-whitelist) writes: the keys of
 * `ckb.udt_whitelist` (fnn's UdtArgInfo, crates/fiber-lib/src/ckb/config.rs) and how the kit's files lay them out.
 */

/** YAML keys of the whitelist and of the section that holds it. */
export const FNN_CONFIG_KEY = {
  CKB: "ckb",
  UDT_WHITELIST: "udt_whitelist",
  NAME: "name",
  SCRIPT: "script",
  CODE_HASH: "code_hash",
  HASH_TYPE: "hash_type",
  ARGS: "args",
  CELL_DEPS: "cell_deps",
  TYPE_ID: "type_id",
  CELL_DEP: "cell_dep",
  OUT_POINT: "out_point",
  TX_HASH: "tx_hash",
  INDEX: "index",
  DEP_TYPE: "dep_type",
  AUTO_ACCEPT_AMOUNT: "auto_accept_amount",
} as const;

/** fnn matches a whitelist entry's `args` as an unanchored regex: these anchors keep the entry to one script's args. */
export const FNN_ARGS_ANCHOR = { START: "^", END: "$" } as const;

/** Spaces per YAML nesting level in the kit's fnn config files. */
export const FNN_YAML_INDENT = 2;

/** An empty YAML list, for a whitelist with no entry. */
export const YAML_EMPTY_LIST = "[]";

/** fnn keeps auto_accept_amount as a u128. */
export const FNN_MAX_AUTO_ACCEPT_AMOUNT = (1n << 128n) - 1n;

/** The fnn nodes of the kit whose whitelists come from FIBER_ASSETS (deploy/testnet/fnn/hub.yml and demo.yml). */
export const FNN_NODE_ROLE = {
  /** fnn-hub: auto-accepts a UDT only where FIBER_ASSETS lets nodes open channels to the hub (peerChannels.minAmount). */
  HUB: "hub",
  /** fnn-demo: auto-accepts the channels fnn-hub opens to it (the asset's autoAcceptAmount, or a configured amount). */
  DEMO: "demo",
} as const;

export type FnnNodeRole = (typeof FNN_NODE_ROLE)[keyof typeof FNN_NODE_ROLE];
