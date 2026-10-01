// Local D1 + R2 (Miniflare, via wrangler's getPlatformProxy) for tests that call
// server modules directly. Migrations are applied to a fresh, throwaway state dir.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPlatformProxy } from "wrangler";
import { openPlatform, setDefaultPlatform } from "../src/server/db";

export async function startPlatform() {
  const state = await mkdtemp(join(tmpdir(), "skillbox-d1-"));
  const config = resolve("wrangler.example.toml");
  const apply = Bun.spawnSync(
    [
      process.execPath,
      "x",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "-c",
      config,
      "--persist-to",
      state,
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1" } },
  );
  if (apply.exitCode !== 0)
    throw new Error(
      "D1 migrations failed: " +
        apply.stderr.toString() +
        apply.stdout.toString(),
    );
  const proxy = await getPlatformProxy<any>({
    configPath: config,
    persist: { path: join(state, "v3") },
  });
  const platform = openPlatform(proxy.env);
  setDefaultPlatform(platform);
  return {
    platform,
    async stop() {
      setDefaultPlatform(undefined);
      await proxy.dispose();
      await rm(state, { recursive: true, force: true });
    },
  };
}
