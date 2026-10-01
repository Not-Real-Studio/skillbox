#!/usr/bin/env bash
# Repeatable Worker acceptance: builds assets, migrates DATABASE_URL, starts
# `wrangler dev` with Hyperdrive pointed at that database and runs
# scripts/test-worker.ts against it. Needs a reachable Postgres, nothing in Cloudflare.
#   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/db bash scripts/test-worker.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?Set DATABASE_URL to a disposable Postgres database}"
port="${SKILLBOX_WORKER_PORT:-8799}"
config="${WRANGLER_CONFIG:-wrangler.example.toml}"
# Not a dependency: keeps workerd out of the Docker image. Pinned for repeatability.
wrangler="${WRANGLER:-bunx wrangler@4.146.0}"
admin_token="${SKILLBOX_ADMIN_TOKEN:-worker_acceptance_admin_token_$(openssl rand -hex 12)}"
origin="http://127.0.0.1:$port"
log="$(mktemp -t skillbox-wrangler.XXXXXX)"

bun run build:worker >/dev/null
bun run migrate

export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$DATABASE_URL"
$wrangler dev -c "$config" --ip 127.0.0.1 --port "$port" \
  --var "SKILLBOX_ORIGIN:$origin" --var "SKILLBOX_ADMIN_TOKEN:$admin_token" \
  >"$log" 2>&1 &
wrangler_pid=$!
trap 'kill "$wrangler_pid" 2>/dev/null; wait "$wrangler_pid" 2>/dev/null; rm -f "$log"' EXIT

for _ in $(seq 60); do
  curl -fsS -o /dev/null "$origin/healthz" 2>/dev/null && break
  kill -0 "$wrangler_pid" 2>/dev/null || { cat "$log"; exit 1; }
  sleep 1
done

status=0
SKILLBOX_URL="$origin" SKILLBOX_ORIGIN="$origin" SKILLBOX_ADMIN_TOKEN="$admin_token" \
  bun scripts/test-worker.ts || status=$?
# Cross-request I/O and uncaught errors surface only in the runtime log.
if grep -E "Uncaught|different request|hanging Promise|Internal service error|Request failed" "$log"; then
  echo "wrangler dev reported runtime errors (above)"
  status=1
fi
if [ "$status" != 0 ] && [ -n "${SKILLBOX_WORKER_LOG:-}" ]; then
  cp "$log" "$SKILLBOX_WORKER_LOG"
fi
exit "$status"
