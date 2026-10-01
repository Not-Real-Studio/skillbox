import type { MiddlewareHandler } from "hono";
import { serveStatic } from "hono/bun";

/**
 * Files the server hands out besides the API. Names are logical:
 * "bootstrap/SKILL.md", "cli/<name>.mjs", and web build files such as "index.html".
 */
export type StaticFiles = {
  text(name: string): Promise<string | null>;
  /** Serves /assets/* from the web build. */
  assets: MiddlewareHandler;
};

const diskPath = (name: string) =>
  name.startsWith("bootstrap/") || name.startsWith("cli/")
    ? name
    : "./dist/" + name;

// Bun: files on disk next to the process, as before.
export const diskFiles: StaticFiles = {
  async text(name) {
    const f = Bun.file(diskPath(name));
    return (await f.exists()) ? f.text() : null;
  },
  assets: serveStatic({ root: "./dist" }),
};
