#!/usr/bin/env bash
# Runs the CKB devnet node or its block producer from the stock nervos/ckb image.
#
#   node   initialises /var/lib/ckb on first start from the shared chain spec (Fiber v0.9.1 dev.toml, which puts the
#          Fiber contracts in genesis), enables the indexer and IntegrationTest RPC modules, then runs the node.
#   miner  asks the node for a block every CKB_BLOCK_INTERVAL_MS through the IntegrationTest RPC `generate_block`, like
#          Fiber's own test harness. Each call builds on the node's current template, so a block refused for a
#          timestamp too far ahead (the Docker VM clock can jump back by more than CKB's 15 s allowance) is retried
#          until the clock catches up. `ckb miner` never retries the same template and stalls the chain until it
#          changes.
#
# Environment (set in docker-compose.yml): CKB_SPEC_FILE, CKB_MINER_LOCK_ARG (node); CKB_NODE_RPC_URL,
# CKB_BLOCK_INTERVAL_MS (miner).
set -eu

DATA_DIR=/var/lib/ckb
EXTRA_RPC_MODULES='"Indexer", "IntegrationTest"'
# Bounds each read of an RPC response, so a hung node cannot stall the producer.
RPC_READ_TIMEOUT_SECONDS=5
MS_PER_SECOND=1000

init_node_dir() {
  echo "Initialising the CKB devnet data directory from $CKB_SPEC_FILE"
  ckb init -C "$DATA_DIR" --chain dev --ba-arg "$CKB_MINER_LOCK_ARG" --force >/dev/null
  sed -i "s|^spec = .*|spec = { file = \"$CKB_SPEC_FILE\" }|" "$DATA_DIR/ckb.toml"
  sed -i "s|^modules = \[\(.*\)\]|modules = [\1, $EXTRA_RPC_MODULES]|" "$DATA_DIR/ckb.toml"
}

run_node() {
  [ -f "$DATA_DIR/ckb.toml" ] || init_node_dir
  exec ckb run -C "$DATA_DIR" --indexer
}

# Calls a parameterless JSON-RPC method on the node and prints the response body. The image has no curl, so this
# speaks HTTP/1.0 over bash's /dev/tcp; the node closes the connection after the response.
rpc_call() {
  local method=$1 host_port host port body line="" response=""
  host_port=${CKB_NODE_RPC_URL#*://}
  host_port=${host_port%%/*}
  host=${host_port%%:*}
  port=${host_port##*:}
  body="{\"id\":1,\"jsonrpc\":\"2.0\",\"method\":\"$method\",\"params\":[]}"
  { exec 3<>"/dev/tcp/$host/$port"; } 2>/dev/null || return 1
  printf 'POST / HTTP/1.0\r\nHost: %s\r\nContent-Type: application/json\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' \
    "$host" "${#body}" "$body" >&3
  while IFS= read -r -t "$RPC_READ_TIMEOUT_SECONDS" line <&3; do response=$line; done
  [ -z "$line" ] || response=$line
  exec 3<&-
  printf '%s' "$response"
}

is_rpc_result() {
  [[ $1 == *'"result":'* ]]
}

run_miner() {
  local interval paused=false response
  interval=$(printf '%d.%03d' $((CKB_BLOCK_INTERVAL_MS / MS_PER_SECOND)) $((CKB_BLOCK_INTERVAL_MS % MS_PER_SECOND)))
  # tini forwards the stop signal to this shell only; exit after the current sleep instead of waiting to be killed.
  trap 'exit 0' INT TERM
  echo "Producing a CKB block every ${CKB_BLOCK_INTERVAL_MS} ms through generate_block on $CKB_NODE_RPC_URL"
  while :; do
    if response=$(rpc_call generate_block) && is_rpc_result "$response"; then
      [ "$paused" = false ] || echo "Producing blocks again"
      paused=false
    elif [ "$paused" = false ]; then
      echo "generate_block failed, retrying every ${CKB_BLOCK_INTERVAL_MS} ms: ${response:-node unreachable}" >&2
      paused=true
    fi
    sleep "$interval"
  done
}

case "${1:-}" in
  node) run_node ;;
  miner) run_miner ;;
  *) echo "usage: docker-entrypoint.sh node|miner" >&2; exit 64 ;;
esac
