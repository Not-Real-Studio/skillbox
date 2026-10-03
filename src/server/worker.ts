// Cloudflare Workers entry — the only runtime of this fork.
// Vars and secrets reach process.env through nodejs_compat_populate_process_env.
// The schema is applied with `wrangler d1 migrations apply`, never here.
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { app } from "./app";
import { openPlatform, withPlatform } from "./db";
import { assetFiles } from "./static-assets";

type Env = {
  ASSETS: { fetch(input: Request | string): Promise<Response> };
  DB: D1Database;
  FILES: R2Bucket;
};
type Context = { waitUntil(promise: Promise<unknown>): void };

export default {
  async fetch(request: Request, env: Env, ctx: Context) {
    const token = process.env.SKILLBOX_ADMIN_TOKEN;
    if (!token || token.length < 32 || !env.DB || !env.FILES)
      return new Response(
        "Skillbox is not configured: set the SKILLBOX_ADMIN_TOKEN secret (32+ characters) and the DB (D1) and FILES (R2) bindings.",
        { status: 503 },
      );
    // Key in path: /k/<clientKey>/<rest> == <rest> with "Authorization: Bearer <clientKey>".
    // For clients that cannot send headers (claude.ai connectors, plain fetch).
    const m = new URL(request.url).pathname.match(/^\/k\/([A-Za-z0-9_-]{20,512})(\/.*)?$/);
    if (m) {
      const url = new URL(request.url);
      url.pathname = m[2] || "/";
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${m[1]}`);
      headers.set("x-skillbox-prefix", `/k/${m[1]}`);
      request = new Request(url.toString(), {
        method: request.method,
        headers,
        body: request.body,
      });
    }
    return withPlatform(openPlatform(env), () =>
      app.fetch(request, { STATIC: assetFiles(env.ASSETS) }, ctx as any),
    );
  },
};
