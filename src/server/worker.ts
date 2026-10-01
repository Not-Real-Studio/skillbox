// Cloudflare Workers entry. The Bun entry is index.ts; both serve the same app.
// Vars and secrets reach process.env through nodejs_compat_populate_process_env.
// The schema is migrated at deploy time (scripts/migrate.ts), never here.
import { app } from "./app";
import { openDatabase, withDatabase } from "./db";
import { assetFiles } from "./static-assets";

type Env = {
  ASSETS: { fetch(input: Request | string): Promise<Response> };
  HYPERDRIVE: { connectionString: string };
};
type Context = { waitUntil(promise: Promise<unknown>): void };

export default {
  async fetch(request: Request, env: Env, ctx: Context) {
    const token = process.env.SKILLBOX_ADMIN_TOKEN;
    if (!token || token.length < 32 || !env.HYPERDRIVE)
      return new Response(
        "Skillbox is not configured: set the SKILLBOX_ADMIN_TOKEN secret (32+ characters) and the HYPERDRIVE binding.",
        { status: 503 },
      );
    // Cloudflare's postgres-js pattern for Hyperdrive: one client per request,
    // closed after the response; Hyperdrive keeps the pooled origin connections.
    const database = openDatabase(env.HYPERDRIVE.connectionString, {
      max: 5,
      fetch_types: false,
    });
    try {
      return await withDatabase(database, () =>
        app.fetch(request, { STATIC: assetFiles(env.ASSETS) }, ctx as any),
      );
    } finally {
      ctx.waitUntil(database.sql.end());
    }
  },
};
