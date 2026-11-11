#!/bin/sh
# Starts fnn with the shared devnet config. On first start it creates the node's CKB wallet key (random, plain hex);
# fnn then encrypts it in place with FIBER_SECRET_KEY_PASSWORD. The bootstrap funds the wallet from the genesis keys.
#
# Environment: FIBER_HOME (base dir), FIBER_CONFIG (config file), FIBER_SECRET_KEY_PASSWORD, and any fnn setting
# (RPC_LISTENING_ADDR, CKB_NODE_RPC_URL, CKB_UDT_WHITELIST, ...), which overrides the config file.
set -eu

KEY_BYTES=32
KEY_FILE="$FIBER_HOME/ckb/key"

if [ ! -f "$KEY_FILE" ]; then
  mkdir -p "$(dirname "$KEY_FILE")"
  od -An -N"$KEY_BYTES" -tx1 /dev/urandom | tr -d ' \n' > "$KEY_FILE"
  echo "Created a new CKB wallet key for this fnn node"
fi

exec fnn -c "$FIBER_CONFIG" -d "$FIBER_HOME" "$@"
