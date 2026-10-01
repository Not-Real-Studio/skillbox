// Acceptance checks for a running Worker (wrangler dev with local D1 + R2). Usage:
//   SKILLBOX_URL=http://127.0.0.1:8799 SKILLBOX_ADMIN_TOKEN=... bun scripts/test-worker.ts
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const base = (process.env.SKILLBOX_URL ?? "http://127.0.0.1:8799").replace(/\/$/, "");
const adminToken = process.env.SKILLBOX_ADMIN_TOKEN ?? "";
const origin = process.env.SKILLBOX_ORIGIN ?? base;
let failures = 0;
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    console.log(`ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name} — ${e instanceof Error ? e.message : e}`);
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function call(path: string, init: RequestInit = {}) {
  const r = await fetch(base + path, init);
  const text = await r.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: r.status, headers: r.headers, body, text };
}
const file = (path: string, text: string) => {
  const b = Buffer.from(text);
  return {
    path,
    content: b.toString("base64"),
    sha256: createHash("sha256").update(b).digest("hex"),
    size: b.length,
    executable: false,
  };
};
const skillMd = (id: string, body: string) =>
  `---\nname: ${id}\ndescription: Worker acceptance fixture ${id}\n---\n\n${body}\n`;

const suffix = randomUUID().slice(0, 8);
const apiSkill = `worker-api-${suffix}`;
const cliSkill = `worker-cli-${suffix}`;
let cookie = "";
let clientKey = "";
const admin = (init: RequestInit = {}) => ({
  ...init,
  headers: {
    Cookie: cookie,
    Origin: origin,
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string>),
  },
});

await check("GET /healthz → 200", async () => {
  const r = await call("/healthz");
  assert(r.status === 200 && r.body.ok === true, `${r.status} ${r.text}`);
});
await check("admin token login", async () => {
  const bad = await call("/api/login", admin({ method: "POST", body: JSON.stringify({ key: "x".repeat(40) }) }));
  assert(bad.status === 401, `wrong key gave ${bad.status}`);
  const r = await fetch(base + "/api/login", admin({ method: "POST", body: JSON.stringify({ key: adminToken }) }));
  assert(r.status === 200, `status ${r.status}: ${await r.text()}`);
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  assert(cookie.startsWith("skillbox_session="), "no session cookie");
});
await check("create skill via PUT /api/skills/:id", async () => {
  const r = await call(`/api/skills/${apiSkill}`, admin({
    method: "PUT",
    body: JSON.stringify({ expectedRevision: null, files: [file("SKILL.md", skillMd(apiSkill, "Created through the API."))] }),
  }));
  assert(r.status === 200 && r.body.revision, `${r.status} ${r.text}`);
  return `revision ${r.body.revision.slice(0, 8)}`;
});
await check("GET /api/skills lists it", async () => {
  const r = await call("/api/skills", admin());
  const items = Array.isArray(r.body) ? r.body : r.body.items;
  assert(r.status === 200 && Array.isArray(items), `${r.status} ${r.text.slice(0, 200)}`);
  assert(items.some((s: any) => s.id === apiSkill), "created skill missing");
  return `${items.length} skill(s)`;
});
await check("profile + client via API", async () => {
  const p = await call("/api/profiles", admin({
    method: "POST",
    body: JSON.stringify({ name: `Worker ${suffix}`, allSkills: true, skillIds: [], permissions: { create: true, update: true, delete: false, propose: false } }),
  }));
  assert(p.status === 200 && p.body.id, `profile: ${p.status} ${p.text}`);
  const c = await call("/api/clients", admin({ method: "POST", body: JSON.stringify({ name: `worker-${suffix}`, profileId: p.body.id }) }));
  assert(c.status === 200 && typeof c.body.token === "string", `client: ${c.status} ${c.text}`);
  clientKey = c.body.token;
});
const mcp = (body: unknown, extra: Record<string, string> = {}) =>
  call("/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + clientKey,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...extra,
    },
    body: JSON.stringify(body),
  });
await check("MCP initialize", async () => {
  const r = await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-worker", version: "1" } },
  });
  assert(r.status === 200 && r.body.result?.serverInfo?.name === "skillbox", `${r.status} ${r.text.slice(0, 300)}`);
  return `protocol ${r.body.result.protocolVersion}`;
});
await check("MCP tools/list", async () => {
  const r = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "MCP-Protocol-Version": "2025-06-18" });
  const tools = r.body.result?.tools;
  assert(r.status === 200 && Array.isArray(tools) && tools.length > 0, `${r.status} ${r.text.slice(0, 300)}`);
  return tools.map((t: any) => t.name).join(", ");
});
// The 2026-07-28 ("modern") protocol goes through createMcpHandler, not the legacy transport.
const modern = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test-worker", version: "1" },
};
await check("MCP server/discover + tools/list (2026-07-28)", async () => {
  const discover = await mcp({ jsonrpc: "2.0", id: 3, method: "server/discover", params: { _meta: modern } }, { "Mcp-Method": "server/discover" });
  assert(discover.status === 200 && discover.body.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name === "skillbox", `discover: ${discover.status} ${discover.text.slice(0, 300)}`);
  const list = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/list", params: { _meta: modern } }, { "Mcp-Method": "tools/list" });
  assert(list.status === 200 && list.body.result?.tools?.length > 0, `tools/list: ${list.status} ${list.text.slice(0, 300)}`);
  return `${list.body.result.tools.length} tools`;
});
await check("skillbox publish (cli/skillbox.mjs)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillbox-worker-"));
  try {
    await mkdir(join(dir, "references"));
    await writeFile(join(dir, "SKILL.md"), skillMd(cliSkill, "Published by the CLI."));
    await writeFile(join(dir, "references/notes.md"), "Notes");
    const p = Bun.spawnSync([process.execPath, resolve("cli/skillbox.mjs"), "publish", dir, cliSkill, "new"], {
      env: { ...process.env, SKILLBOX_URL: base, SKILLBOX_TOKEN: clientKey, SKILLBOX_CONFIG: join(dir, "none.json") },
    });
    const out = p.stdout.toString();
    assert(p.exitCode === 0, `exit ${p.exitCode}: ${p.stderr.toString()}${out}`);
    const revision = JSON.parse(out).revision;
    const r = await call(`/api/skills/${cliSkill}`, admin());
    assert(r.status === 200, `GET after publish: ${r.status}`);
    return `revision ${String(revision).slice(0, 8)}`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
await check("MCP load_skill + read_skill_file", async () => {
  const loaded = await mcp(
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "load_skill", arguments: { id: cliSkill } } },
    { "MCP-Protocol-Version": "2025-06-18" },
  );
  const skill = JSON.parse(loaded.body.result?.content?.[0]?.text ?? "null");
  assert(skill?.instructions?.includes("Published by the CLI."), `load_skill: ${loaded.text.slice(0, 300)}`);
  const read = await mcp(
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "read_skill_file", arguments: { id: cliSkill, revision: skill.revision, path: "references/notes.md" } } },
    { "MCP-Protocol-Version": "2025-06-18" },
  );
  const file = JSON.parse(read.body.result?.content?.[0]?.text ?? "null");
  assert(file?.text === "Notes", `read_skill_file: ${read.text.slice(0, 300)}`);
});
await check("bundle download (GET /api/skills/:id/bundle)", async () => {
  const r = await call(`/api/skills/${cliSkill}/bundle`, admin());
  assert(r.status === 200 && r.body.format === "skillbox/v1", `${r.status} ${r.text.slice(0, 200)}`);
  const notes = r.body.files.find((f: any) => f.path === "references/notes.md");
  assert(notes && Buffer.from(notes.content, "base64").toString() === "Notes", "bundle content differs");
  return `${r.body.files.length} files`;
});

const put = (id: string, files: unknown[], expectedRevision: string | null) =>
  call(`/api/skills/${id}`, admin({ method: "PUT", body: JSON.stringify({ expectedRevision, files }) }));
const bundleOf = async (id: string, revision?: string) =>
  (await call(`/api/skills/${id}/bundle${revision ? `?revision=${revision}` : ""}`, admin())).body;

await check("1.5 MB file round-trips byte for byte", async () => {
  const id = `worker-large-${suffix}`;
  const bytes = new Uint8Array(1_500_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919 + (i >> 8)) & 0xff;
  const big = {
    path: "assets/large.bin",
    content: Buffer.from(bytes).toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    executable: false,
  };
  const r = await put(id, [file("SKILL.md", skillMd(id, "Large asset.")), big], null);
  assert(r.status === 200, `publish: ${r.status} ${r.text.slice(0, 200)}`);
  const back = (await bundleOf(id)).files.find((f: any) => f.path === big.path);
  assert(back, "file missing from bundle");
  assert(Buffer.from(back.content, "base64").equals(Buffer.from(bytes)), "bytes differ");
  assert(back.sha256 === big.sha256, "digest differs");
});
await check("skill with 50 files", async () => {
  const id = `worker-many-${suffix}`;
  const many = [file("SKILL.md", skillMd(id, "Many files."))];
  for (let i = 0; i < 49; i++) many.push(file(`references/part-${String(i).padStart(2, "0")}.md`, `Part ${i}\n`));
  const r = await put(id, many, null);
  assert(r.status === 200, `publish: ${r.status} ${r.text.slice(0, 200)}`);
  const loaded = await call(`/api/skills/${id}`, admin());
  assert(loaded.body.files?.length === 50, `load lists ${loaded.body.files?.length} files`);
  const back = await bundleOf(id);
  assert(back.files.length === 50, `bundle has ${back.files.length} files`);
  const part = back.files.find((f: any) => f.path === "references/part-37.md");
  assert(Buffer.from(part.content, "base64").toString() === "Part 37\n", "part-37 differs");
});
let raceSkill = "";
let raceFirst = "";
await check("two parallel publishes with one expected revision → one 409", async () => {
  raceSkill = `worker-race-${suffix}`;
  const created = await put(raceSkill, [file("SKILL.md", skillMd(raceSkill, "Version one."))], null);
  assert(created.status === 200, `create: ${created.status}`);
  raceFirst = created.body.revision;
  const results = await Promise.all(
    ["Edit A.", "Edit B."].map((body) => put(raceSkill, [file("SKILL.md", skillMd(raceSkill, body))], raceFirst)),
  );
  const statuses = results.map((r) => r.status).sort();
  assert(statuses[0] === 200 && statuses[1] === 409, `statuses ${statuses.join(", ")}`);
  const history = await call(`/api/skills/${raceSkill}/history`, admin());
  assert(history.body.length === 2, `history has ${history.body.length} revisions`);
});
await check("restore an old revision", async () => {
  const current = (await call(`/api/skills/${raceSkill}`, admin())).body.revision;
  const r = await call(`/api/skills/${raceSkill}/restore`, admin({ method: "POST", body: JSON.stringify({ revision: raceFirst, expectedRevision: current }) }));
  assert(r.status === 200, `restore: ${r.status} ${r.text.slice(0, 200)}`);
  const loaded = (await call(`/api/skills/${raceSkill}`, admin())).body;
  assert(loaded.revision === r.body.revision && loaded.instructions.includes("Version one."), "restored content differs");
  const stale = await call(`/api/skills/${raceSkill}/restore`, admin({ method: "POST", body: JSON.stringify({ revision: raceFirst, expectedRevision: current }) }));
  assert(stale.status === 409, `stale restore gave ${stale.status}`);
});
await check("search: Russian word from the description, part of the id", async () => {
  const id = `worker-poisk-${suffix}`;
  const md = `---\nname: ${id}\ndescription: Помогает готовить сметы для ремонта квартиры\n---\n\nИнструкция.\n`;
  const r = await put(id, [file("SKILL.md", md)], null);
  assert(r.status === 200, `publish: ${r.status}`);
  const found = async (query: string) =>
    ((await call(`/api/skills?query=${encodeURIComponent(query)}`, admin())).body.items ?? []).map((s: any) => s.id);
  for (const query of ["сметы", "ремонт", "Квартиры", `poisk-${suffix}`])
    assert((await found(query)).includes(id), `"${query}" did not find ${id}`);
  assert(!(await found("бетономешалка")).includes(id), "unrelated word matched");
});
for (const [path, local] of [
  ["/bootstrap/SKILL.md", "bootstrap/SKILL.md"],
  ["/cli/skillbox.mjs", "cli/skillbox.mjs"],
]) {
  await check(`GET ${path} matches the repo file`, async () => {
    const r = await call(path);
    assert(r.status === 200, `status ${r.status}`);
    assert(r.text === (await Bun.file(local).text()), "content differs");
  });
}
await check("web UI and /assets/*", async () => {
  const index = await call("/");
  assert(index.status === 200 && index.text.includes("<div id=\"root\">"), `index ${index.status}`);
  assert(index.headers.get("content-security-policy"), "security headers missing");
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(index.text)?.[1];
  assert(asset, "no script in index.html");
  const r = await call(asset);
  assert(r.status === 200 && /javascript/.test(r.headers.get("content-type") ?? ""), `${asset}: ${r.status}`);
});

// Exercises node:crypto sealing and the MCP SDK 1.30 client inside the Worker;
// nothing listens on the endpoint, so the catalog must fail with the app's own 502.
await check("Executor settings (sealed secrets, SDK client)", async () => {
  const put = await call("/api/settings/executor", admin({ method: "PUT", body: JSON.stringify({ endpoint: "https://127.0.0.1:9/mcp", bearer: "fixture-bearer" }) }));
  assert(put.status === 200 && put.body.authMethod === "token", `configure: ${put.status} ${put.text}`);
  const catalog = await call("/api/executor/integrations?refresh=true", admin());
  assert(catalog.status === 502 && /Executor/.test(catalog.body.error), `catalog: ${catalog.status} ${catalog.text.slice(0, 200)}`);
  const off = await call("/api/executor/disconnect", admin({ method: "POST" }));
  assert(off.status === 200, `disconnect: ${off.status}`);
});
await check("AI gateway key: sealed compare-and-swap write", async () => {
  const put = await call("/api/settings/ai-gateway", admin({ method: "PUT", body: JSON.stringify({ apiKey: "fixture-gateway-key" }) }));
  assert(put.status === 200, `configure: ${put.status} ${put.text}`);
  const get = await call("/api/settings/ai-gateway", admin());
  assert(get.status === 200 && get.body.configured === true, `read back: ${get.status} ${get.text}`);
  assert(!get.text.includes("fixture-gateway-key"), "key leaked in settings");
  const clear = await call("/api/settings/ai-gateway", admin({ method: "PUT", body: JSON.stringify({ apiKey: null }) }));
  assert(clear.status === 200, `clear: ${clear.status} ${clear.text}`);
});
await check("30 concurrent requests (per-request bindings)", async () => {
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      i % 3 === 0
        ? call("/healthz")
        : i % 3 === 1
          ? call("/api/skills", admin())
          : mcp({ jsonrpc: "2.0", id: 10 + i, method: "tools/call", params: { name: "search_skills", arguments: { query: "fixture" } } }, { "MCP-Protocol-Version": "2025-06-18" }),
    ),
  );
  const bad = results.filter((r) => r.status !== 200 || r.body?.result?.isError);
  assert(!bad.length, `${bad.length} failed: ${bad[0]?.status} ${bad[0]?.text.slice(0, 200)}`);
});
if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("All Worker checks passed");
