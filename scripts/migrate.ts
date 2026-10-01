// Applies the idempotent schema migration to DATABASE_URL (or DATABASE_URL_FILE).
// The Bun server migrates on start; a Worker deployment runs this once per deploy.
import { loadRuntimeSecrets } from "../src/server/runtime-env";
loadRuntimeSecrets();
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL");
const { migrate, connection } = await import("../src/server/db");
try {
  await migrate();
  console.log("Schema is up to date");
} finally {
  await connection.end();
}
