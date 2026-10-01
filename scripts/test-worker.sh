#!/usr/bin/env bash
# Repeatable Worker acceptance on local D1 + R2: builds assets, applies the D1
# migrations to a throwaway state directory, starts `wrangler dev` on it and
# runs scripts/test-worker.ts. Needs nothing in Cloudflare and no database.
#   bash scripts/test-worker.sh
set -euo pipefail
cd "$(dirname "$0")/.."
port="${SKILLBOX_WORKER_PORT:-8799}"
config="${WRANGLER_CONFIG:-wrangler.example.toml}"
admin_token="${SKILLBOX_ADMIN_TOKEN:-worker_acceptance_admin_token_$(openssl rand -hex 12)}"
origin="http://127.0.0.1:$port"
state="$(mktemp -d -t skillbox-worker-state.XXXXXX)"
log="$state/wrangler.log"

bun run build:worker >/dev/null
bunx wrangler d1 migrations apply DB --local -c "$config" --persist-to "$state" >/dev/null

bunx wrangler dev -c "$config" --persist-to "$state" --ip 127.0.0.1 --port "$port" \
  --var "SKILLBOX_ORIGIN:$origin" --var "SKILLBOX_ADMIN_TOKEN:$admin_token" \
  >"$log" 2>&1 &
wrangler_pid=$!
trap 'kill "$wrangler_pid" 2>/dev/null; wait "$wrangler_pid" 2>/dev/null; rm -rf "$state"' EXIT

for _ in $(seq 60); do
  curl -fsS -o /dev/null "$origin/healthz" 2>/dev/null && break
  kill -0 "$wrangler_pid" 2>/dev/null || { cat "$log"; exit 1; }
  sleep 1
done

status=0
SKILLBOX_URL="$origin" SKILLBOX_ORIGIN="$origin" SKILLBOX_ADMIN_TOKEN="$admin_token" \
  bun scripts/test-worker.ts || status=$?
# Cross-request I/O and uncaught errors surface only in the runtime log.
if grep -E "Uncaught|different request|hanging Promise|Request failed" "$log"; then
  echo "wrangler dev reported runtime errors (above)"
  status=1
fi
if [ "$status" != 0 ] && [ -n "${SKILLBOX_WORKER_LOG:-}" ]; then
  cp "$log" "$SKILLBOX_WORKER_LOG"
fi
exit "$status"
