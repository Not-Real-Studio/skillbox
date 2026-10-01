# Cloudflare: Worker + D1 + R2

This fork runs only on Cloudflare. One Worker serves the Hono app; the web UI, `bootstrap/SKILL.md` and `cli/*.mjs` are Workers Static Assets; metadata lives in D1; file bytes live in R2. There is no other runtime: locally it is `wrangler dev` with local D1 and R2.

## Layout

| Concern | Where |
| --- | --- |
| Entry | `src/server/worker.ts` (`export default { fetch }`) |
| Request context | `src/server/db.ts`: the entry binds `env.DB`/`env.FILES` per request through `AsyncLocalStorage`; business code imports `db` (Drizzle over D1) and `d1` (raw D1) |
| Schema | `src/server/schema.ts` (Drizzle `sqlite-core`) and `migrations/*.sql` — keep them in step |
| Files | `src/server/files.ts`: R2 objects `files/<sha256>`; rows hold a manifest `[{path, sha256, size, executable, mime}]` |
| Search | FTS5 table `skills_fts` (`porter unicode61 remove_diacritics 2`), kept in sync by triggers |
| Config | vars and secrets reach `process.env` (`nodejs_compat_populate_process_env`) |

### What changed from PostgreSQL

- **Types.** JSON in `TEXT` (`mode: "json"`), timestamps as ISO-8601 `TEXT` (they sort as time), booleans as `0/1`, UUID defaults generated in code.
- **Files.** A revision used to carry all its files base64 in one `jsonb` row; D1 rows are limited to 2 MB and an 8 MB skill would not fit. Now each file is an R2 object addressed by its SHA-256, so identical bytes are stored once across revisions and skills. Publishing writes R2 first, then the row; R2 verifies the digest on upload and the app re-verifies it on every read. Proposals use the same store. Objects are never deleted, so a failed publish can leave an unreferenced object, never a dangling manifest.
- **Transactions.** D1 has no interactive transactions, row locks or advisory locks. `publish` runs one atomic `batch`: the first statement writes the skill row only if it still has the expected revision (and, when bundle edges, lifecycle or replacement change, only if the library graph version read before validation is unchanged); every following statement (revision row, event, profile grant, graph version bump, proposal status) is conditional on that write having happened. A lost race is the same 409 as before and changes nothing. Profile names and active client names are unique indexes on a normalized `name_key` (SQLite's `lower()` is ASCII-only, so normalization happens in code); a profile update carries its version in the `UPDATE`; deleting a profile is one conditional `DELETE`; approving a proposal publishes and closes it in the same batch, guarded by `status='pending'`; provider settings use compare-and-swap on the stored value.
- **JSON queries.** `context->>'source'` works as is in SQLite; `skill_ids || …` became `json_insert(skill_ids, '$[#]', ?)`; `LATERAL` joins became correlated subqueries. Long ID lists are passed as one JSON parameter (`IN (SELECT value FROM json_each(?))`) because D1 allows at most 100 bound parameters per query.
- **Search.** Every word of the query must match in `skills_fts` as a prefix (`"word"*`), ranked by `bm25()`; plus `LIKE` substring matches on the ID and description, ranked last. `porter` stems English; other scripts, Russian included, are tokenized by `unicode61` without stemming — the prefix match covers most inflections (`ремонт` finds `ремонта`), not all (`окно` does not find `окна`).
- **Removed:** the legacy-grant migration (clients without a profile), the Docker/Compose/Umbrel tooling, folder import/export and PostgreSQL backups. Use `scripts/import-from-skillbox.ts` to move an instance and D1 Time Travel / `wrangler d1 export` for backups (R2 objects are immutable and content-addressed).

## Deploy

1. `cp wrangler.example.toml wrangler.toml` (git-ignored). Set `name` and `SKILLBOX_ORIGIN` (the public HTTPS origin), optionally `SKILLBOX_ALLOWED_ORIGINS`.
2. `bunx wrangler d1 create skillbox` → put the `database_id` into `[[d1_databases]]`.
3. `bunx wrangler r2 bucket create skillbox-files` (or your name in `[[r2_buckets]] bucket_name`). Keep the bucket private; the Worker is its only reader.
4. `openssl rand -base64 48 | bunx wrangler secret put SKILLBOX_ADMIN_TOKEN` (32+ characters). It also derives the key that encrypts stored provider credentials; rotating it means reconnecting them. Without it the Worker answers 503.
5. `bun run deploy` — builds `dist-worker/`, applies pending `migrations/` to the remote D1, deploys. Migrations are a deploy step; the Worker never migrates or checks the schema.
6. Add a custom domain to the Worker equal to `SKILLBOX_ORIGIN`.
7. Add a WAF rate-limiting rule for `POST /api/login`: the built-in limiter is per isolate.

Moving an existing instance: deploy, then run `scripts/import-from-skillbox.ts` (see the README) and `scripts/verify-import.ts`.

## Local run and acceptance

```sh
bun test                       # unit tests: local D1 + R2 via wrangler's getPlatformProxy
bash scripts/test-worker.sh    # end-to-end: wrangler dev with local D1 + R2
```

`scripts/test-worker.sh` builds the assets, applies the migrations to a throwaway state directory, starts `wrangler dev` on it and checks: `/healthz`, admin login, creating and listing skills, profile and client creation, MCP `initialize`/`tools/list` (2025-06-18 and 2026-07-28), `load_skill` and `read_skill_file`, `skillbox publish` from `cli/skillbox.mjs`, bundle download, a 1.5 MB file round-trip byte for byte, a 50-file skill, two parallel publishes on one expected revision (one 409), restoring an old revision, search by a Russian word and by part of an ID, downloads of `bootstrap/SKILL.md`, `cli/skillbox.mjs` and the web assets, encrypted Executor and provider settings, and 30 concurrent requests. It fails if the runtime log shows an uncaught error.

## Limits that touch this code

D1/R2/Workers limits below are Cloudflare's published values as known when this was written; check the current limits pages. **Workers Paid is the realistic plan.**

- **D1 row ≤ 2 MB.** File bytes are in R2. What remains per skill: `search_text` (title, description, tags and all `.md` files, **cut at 500,000 characters** — text beyond that is not searchable), the revision manifest (≈ 300 bytes per file, ~110 KB for 400 files with long paths), metadata (icons ≤ 32 KB).
- **D1 SQL statement ≤ 100 KB, ≤ 100 bound parameters.** Every value goes as a bound parameter, never inlined, so statements stay short; ID lists use one `json_each` parameter. Large values (`search_text`, manifests) are bound parameters, which D1 documents separately from statement length. Verified locally (Miniflare) with a 1 MB markdown file and a 400-file skill; not verified on production D1.
- **Request body.** The app caps bodies at 12 MB; a skill is ≤ 8 MB, ≤ 2 MB per file, base64 in JSON. Workers accept more.
- **Subrequests per request** (Free 50; Paid much higher). R2 and D1 binding calls count. Publishing does one `head` (and a `put` if missing) per distinct file — a 400-file publish is up to 800 R2 operations; a bundle download or a restore reads every file; a GitHub import fetches one URL per file. On Free these break beyond roughly 20–45 files. Load, `read_skill_file` and MCP resource reads touch one or two objects; MCP `skills/list` reads one `SKILL.md` per entry on the page (25).
- **D1 queries per request** (Free 50, Paid 1000). A publish is about six queries plus one batch; listing is three or four.
- **Simultaneous connections: 6.** R2 reads and writes run at most six at a time.
- **CPU time** (Free 10 ms). Publishing decodes base64, hashes every file and parses front matter; R2 integrity re-checks on read hash the bytes again. Multi-megabyte publishes and bundle downloads do not fit in 10 ms.
- **Memory: 128 MB.** A bundle download holds every file of the revision base64-encoded (≤ 8 MB raw → ~11 MB, plus the JSON) — fine; do not raise the package limits without streaming.
- **Bundle size.** ≈ 2.4 MB, 0.45 MB gzipped (`wrangler deploy --dry-run`), under the Free 3 MB limit.
- **Per-isolate state.** Login limiter, GitHub-import concurrency guard, Executor catalog cache/queue and the recommendation cache are module variables: per isolate on Workers.
- **Consistency.** D1 runs one writer; conditional batches give the old 409 semantics. Concurrent graph changes (bundle edits, archiving, replacements) conflict with each other more often than under the old global lock-and-wait: a loser gets 409 and retries instead of waiting.
