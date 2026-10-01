# Cloudflare Workers

The same code runs as a Bun process (Docker Compose, `bun src/server/index.ts`) or as a Cloudflare Worker. In the Worker, the Hono app is the `fetch` handler, the web UI, `bootstrap/SKILL.md` and `cli/*.mjs` are Workers Static Assets, and the database is your existing PostgreSQL reached through Hyperdrive. The SQL and the schema are the same in both modes.

## How the Worker differs from the Bun process

| Concern | Bun | Worker |
| --- | --- | --- |
| Entry | `src/server/index.ts` | `src/server/worker.ts` |
| Database client | one pool per process (`DATABASE_URL`) | one postgres-js client per request from `env.HYPERDRIVE.connectionString`, closed with `ctx.waitUntil`. Business code still imports `db`/`connection`; they resolve to the request's client through `AsyncLocalStorage` |
| Static files | read from disk (`dist/`, `bootstrap/`, `cli/`) | read through the `ASSETS` binding from `dist-worker/` |
| Configuration | `process.env`, `*_FILE` secrets | vars and secrets reach `process.env` via `nodejs_compat_populate_process_env`; `*_FILE` is Bun-only |
| Migrations | on every start | `bun run migrate` once per deploy; the Worker never migrates |

**Why the Worker does not check the schema.** `migrate()` is about thirty idempotent DDL statements plus data backfills; running it per request, or even once per isolate, would add database round-trips to cold requests and race between isolates. A cheap version check would need a schema-version table that upstream does not have, i.e. a schema change only for this port. So migration is a deploy step (`bun run migrate` against the same database, before `wrangler deploy`). If it is skipped, requests touching new columns fail with a 500 and the Worker log shows the SQL error.

## Deploy

Requirements: a Cloudflare account with Workers, a PostgreSQL 14+ database reachable from the internet (Neon, Supabase, your own server with TLS), Bun locally.

1. **Configuration.** `cp wrangler.example.toml wrangler.toml` (ignored by git). Set `name`, `SKILLBOX_ORIGIN` (the public HTTPS origin, e.g. `https://skills.example.com`) and, if needed, `SKILLBOX_ALLOWED_ORIGINS` (comma-separated extra origins).
2. **Hyperdrive.** Create it over your database **with caching disabled**:
   ```sh
   bunx wrangler@4.146.0 hyperdrive create skillbox \
     --connection-string="postgres://USER:PASSWORD@HOST:5432/DB" --caching-disabled
   ```
   Put the printed id into `[[hyperdrive]] id`. Hyperdrive caches read queries by default; Skillbox relies on reading its own writes (revisions, `expectedRevision` checks, sessions), so a cached `SELECT` could return stale skills, revisions, clients or sessions (e.g. a revoked key still accepted) for up to the cache TTL.
3. **Schema.** `DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/DB" bun run migrate` — the same database as in step 2. Repeat on every upgrade, before deploying.
4. **Admin token.** `openssl rand -base64 48 | bunx wrangler@4.146.0 secret put SKILLBOX_ADMIN_TOKEN` (at least 32 characters). It also derives the key that encrypts stored integration credentials, see [deployment](deployment.md) before rotating it. Without it the Worker answers 503.
5. **Build and deploy.** `bun install && bun run build:worker && bun run deploy:worker`.
6. **Domain.** Add a custom domain to the Worker (Workers & Pages → the Worker → Settings → Domains & Routes, or `routes = [{ pattern = "skills.example.com", custom_domain = true }]` in `wrangler.toml`) and make sure it equals `SKILLBOX_ORIGIN`.
7. **Login protection.** The built-in login limiter (10 failures per minute) is per isolate, and Cloudflare runs many isolates. Add a WAF rate-limiting rule for `POST /api/login`.

Clients connect exactly as with a self-hosted instance: `SKILLBOX_URL=https://skills.example.com`, `/mcp` for MCP, `/cli/skillbox.mjs` for the CLI.

## Local run and acceptance

```sh
# Any disposable Postgres database; nothing in Cloudflare is needed.
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/skillbox_worker bash scripts/test-worker.sh
```

The script builds `dist-worker/`, migrates the database, starts `wrangler dev` with Hyperdrive pointed at it (`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`) and checks: `/healthz`, admin login, creating and listing skills, profile and client creation, MCP `initialize`/`tools/list` (2025-06-18) and `server/discover`/`tools/list` (2026-07-28) with a client key, `skillbox publish` from `cli/skillbox.mjs`, downloads of `bootstrap/SKILL.md`, `cli/skillbox.mjs` and the web assets, Executor and AI-gateway settings (encrypted storage), and 30 concurrent requests. It fails if the runtime log shows an uncaught error. `scripts/test-worker.ts` alone also runs against a Bun server (`SKILLBOX_URL=http://127.0.0.1:4791`).

For interactive development: `cp wrangler.example.toml wrangler.toml`, set `localConnectionString`, put `SKILLBOX_ADMIN_TOKEN=...` into `.dev.vars`, `bun run build:worker && bun run dev:worker`.

## Workers limits that touch this code

Values below are Cloudflare's published limits as known at the time of writing; check the current [limits page](https://developers.cloudflare.com/workers/platform/limits/) for your plan. **The Workers Paid plan is the realistic target**; the Free plan breaks publishing larger skills and GitHub import.

- **Request body.** The app caps bodies at 12 MB (`bodyLimit`), same as Bun's `maxRequestBodySize`. The CLI sends files base64 in JSON with a 2 MB-per-file limit (≈2.7 MB encoded); the MCP schema allows 3,000,000 characters per file. Workers accept far larger bodies (100 MB on Free/Pro), so the app's own limit is the binding one.
- **CPU time.** Free: 10 ms per request. Publishing decodes base64, hashes every file (SHA-256), parses front matter and validates with zod — a multi-megabyte publish does not fit in 10 ms. Paid: 30 s by default. Full-text search (`to_tsvector` GIN index), grant expansion and bundle resolution run in PostgreSQL and cost the Worker only I/O wait, which is not CPU time.
- **Subrequests.** Free: 50 per request; Paid: much higher. GitHub import fetches the tree plus one request per file (up to 400 files), four at a time — on Free, imports of more than roughly 45 files fail. Postgres traffic goes over one Hyperdrive connection per request and is not a per-query subrequest.
- **Simultaneous connections.** 6 open connections per request. The per-request client is capped at `max: 5`; GitHub import uses 4 parallel downloads plus the database, so it stays within the limit (excess connections queue, not fail).
- **Memory.** 128 MB per isolate. A 12 MB JSON body is held as text, parsed and decoded to buffers — several copies, still well under the limit.
- **Script size.** The bundle is about 2.5 MB, 0.5 MB gzipped (`wrangler deploy --dry-run`), under the Free 3 MB compressed limit.
- **Per-isolate state.** The login limiter, the GitHub-import concurrency guard (2 concurrent / 12 per minute), the Executor catalog cache (60 s) and the Executor serialization queue are module variables. In Bun they are global for the instance; on Workers they are per isolate, so the limits are weaker and Executor setting changes are not serialized across isolates. Use the WAF rule above for login.
- **`run_worker_first = true`.** Every request, including `/assets/*`, runs the Worker so that the same security headers, SPA fallback and routing apply as in Bun. Asset requests therefore count as Worker requests.
