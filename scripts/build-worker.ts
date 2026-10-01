// Builds the Workers Static Assets directory: web UI plus bootstrap/ and cli/.
import { cp, rm } from "node:fs/promises";
const out = "dist-worker";
await rm(out, { recursive: true, force: true });
const vite = Bun.spawnSync(["bunx", "vite", "build", "--outDir", out], {
  stdout: "inherit",
  stderr: "inherit",
});
if (vite.exitCode !== 0) process.exit(vite.exitCode ?? 1);
for (const dir of ["bootstrap", "cli"])
  await cp(dir, `${out}/${dir}`, { recursive: true });
console.log(`Worker assets in ${out}/`);
