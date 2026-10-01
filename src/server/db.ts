import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/d1";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import * as schema from "./schema";
/** Per-request platform bindings: D1 for metadata, R2 for file bytes. */
export function openPlatform(env: { DB: D1Database; FILES: R2Bucket }) {
  return {
    d1: env.DB,
    files: env.FILES,
    db: drizzle(env.DB as any, { schema }),
  };
}
export type Platform = ReturnType<typeof openPlatform>;
// Workers forbid sharing I/O objects between requests: the Worker entry binds
// each request with withPlatform(). Scripts and tests may set a process-wide
// default instead (setDefaultPlatform), e.g. wrangler's getPlatformProxy().
const scope = new AsyncLocalStorage<Platform>();
let fallback: Platform | undefined;
export const setDefaultPlatform = (platform: Platform | undefined) => {
  fallback = platform;
};
export const platform = () => {
  const current = scope.getStore() ?? fallback;
  if (!current) throw new Error("No D1/R2 bindings for this request");
  return current;
};
export const withPlatform = <T>(value: Platform, fn: () => T) =>
  scope.run(value, fn);
function delegate<T extends object>(target: () => T): T {
  return new Proxy({} as T, {
    get: (_, prop) => {
      const value = Reflect.get(target(), prop);
      return typeof value === "function" ? value.bind(target()) : value;
    },
    has: (_, prop) => Reflect.has(target(), prop),
  });
}
/** Drizzle over the current request's D1 binding. */
export const db = delegate(() => platform().db);
/** Raw D1 binding, for conditional batches drizzle cannot express. */
export const d1 = delegate(() => platform().d1);
