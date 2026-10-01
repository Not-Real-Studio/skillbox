import type { MiddlewareHandler } from "hono";

/**
 * Files the server hands out besides the API. Names are logical:
 * "bootstrap/SKILL.md", "cli/<name>.mjs", and web build files such as "index.html".
 */
export type StaticFiles = {
  text(name: string): Promise<string | null>;
  /** Serves /assets/* from the web build. */
  assets: MiddlewareHandler;
};
/** No assets bound (unit tests calling app.request directly). */
export const noStaticFiles: StaticFiles = {
  text: async () => null,
  assets: (_, next) => next(),
};

type Assets = { fetch(input: Request | string): Promise<Response> };

// Workers Static Assets: the build copies dist/, bootstrap/ and cli/ into one
// directory (see scripts/build-worker.ts); html_handling is "none", so names map 1:1.
export function assetFiles(assets: Assets): StaticFiles {
  const get = (name: string) =>
    assets.fetch("https://assets.invalid/" + name.replace(/^\/+/, ""));
  return {
    async text(name) {
      const r = await get(name);
      return r.ok ? r.text() : null;
    },
    async assets(c, next) {
      const r = await get(new URL(c.req.url).pathname);
      if (!r.ok) return next();
      const type = r.headers.get("Content-Type");
      if (type) c.header("Content-Type", type);
      return c.body(r.body as ReadableStream);
    },
  };
}
