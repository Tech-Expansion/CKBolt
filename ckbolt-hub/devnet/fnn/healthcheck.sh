#!/bin/sh
# Healthy when the fnn JSON-RPC answers node_info on its configured listening address.
set -eu

curl -fsS -m 5 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"node_info","params":[]}' \
  "http://$RPC_LISTENING_ADDR" | grep -q '"pubkey"'
