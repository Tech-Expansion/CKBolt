#!/bin/sh
# Creates an LND node's wallet without a prompt (`lncli create` needs a terminal). Runs INSIDE the LND container, fed on
# stdin by `npm --prefix deploy run testnet -- wallet <node>`, which saves this script's output to
# secrets/wallet/<node>.seed (mode 600) on the server:
#   docker compose exec -T lnd-hub sh -s < lnd/init-wallet.sh > secrets/wallet/lnd-hub.seed.pending
# It asks LND for a fresh aezeed (GenSeed), creates the wallet with it and the unlock password LND already reads at
# start-up (InitWallet), and prints the 24 seed words on one line: its only output. Uses the REST listener that lnd.conf
# binds to the container's own loopback, and the tools of the lightninglabs/lnd image (GNU wget, jq, base64).
set -eu

REST_URL="${LND_REST_URL:-https://localhost:8080}"
TLS_CERT="${LND_TLS_CERT:-/root/.lnd/tls.cert}"
PASSWORD_FILE="${LND_WALLET_PASSWORD_FILE:-/run/secrets/lnd-wallet-password}"

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
umask 077

# GET or POST (with a body file) to LND REST; on failure, LND's answer goes to stderr, never to stdout.
rest() {
  path="$1"
  shift
  if wget -q --content-on-error -O "$work_dir/response" --ca-certificate="$TLS_CERT" "$@" "$REST_URL$path"; then
    cat "$work_dir/response"
  else
    echo "LND REST $path failed: $(cat "$work_dir/response" 2>/dev/null)" >&2
    return 1
  fi
}

mnemonic=$(rest /v1/genseed | jq -ce '.cipher_seed_mnemonic')
password=$(base64 < "$PASSWORD_FILE" | tr -d '\n')
jq -n --arg password "$password" --argjson mnemonic "$mnemonic" \
  '{wallet_password: $password, cipher_seed_mnemonic: $mnemonic}' > "$work_dir/init.json"
rest /v1/initwallet --header='content-type: application/json' --post-file="$work_dir/init.json" > /dev/null
printf '%s\n' "$mnemonic" | jq -r 'join(" ")'
