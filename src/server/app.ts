import * as access from "./access";
import * as executor from "./executor";
import * as gateway from "./gateway";
import { appOrigin as origin, allowedOrigins } from "./config";
import { parseSkillIcon } from "../skill-icons";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { eq, desc, lt, and, sql, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { isIconAsset } from "../package-metrics";
import { db } from "./db";
import { noStaticFiles, type StaticFiles } from "./static-assets";
import { clients, sessions, events, profiles, skills, skillShares, nameKey } from "./schema";
import { asSkillFiles, withContent } from "./files";
import { uniqueViolation } from "./access";
import {
  authenticate,
  isAdminToken,
  createClient,
  assertAdmin,
  token,
} from "./auth";
import * as lib from "./library";
import { handleMcp, fileSchema } from "./mcp";
import type { Principal } from "../shared";
import { recommendationInput } from "./recommendations";
import { compatibilityPage, manifestFor } from "./skill-resources";
import {
  githubImportInput,
  parseGitHubUrl,
  prepareGitHubImport,
} from "./github-import";
export const app = new Hono<{
  Variables: { principal: Principal };
  Bindings: { STATIC?: StaticFiles };
}>();
// The Worker entry passes STATIC (Workers Static Assets).
const files = async (c: { env?: { STATIC?: StaticFiles } }) =>
  c.env?.STATIC ?? noStaticFiles;
const required = async (c: Parameters<typeof files>[0], name: string) => {
  const text = await (await files(c)).text(name);
  if (text === null) throw new Error("Missing static file");
  return text;
};
const loginAttempts: number[] = [];
app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  c.header("Cache-Control", "no-store");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  await next();
});
app.use("*", bodyLimit({ maxSize: 12_000_000 }));
app.onError((e, c) => {
  if (e instanceof lib.Problem)
    return c.json({ error: e.message }, e.status as any);
  if (e instanceof z.ZodError)
    return c.json(
      {
        error: "Invalid request",
        issues: e.issues.map((i) => ({ path: i.path, message: i.message })),
      },
      400,
    );
  console.error("Request failed", e instanceof Error ? e.name : "unknown");
  return c.json({ error: "Internal service error" }, 500);
});
app.get("/healthz", async (c) => {
  await db.run(sql`select 1`);
  return c.json({ ok: true, service: "skillbox" });
});
app.use("/api/*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const provided = c.req.header("Origin");
    if (provided && !allowedOrigins().has(provided))
      throw new lib.Problem(403, "Origin not allowed");
    if (
      !c.req.header("Authorization") &&
      (!provided || !allowedOrigins().has(provided))
    )
      throw new lib.Problem(403, "Origin is required");
  }
  await next();
});
app.post("/api/login", async (c) => {
  const { key } = z
    .object({ key: z.string().min(1).max(512) })
    .parse(await c.req.json());
  const now = Date.now();
  while (loginAttempts.length && loginAttempts[0] < now - 60000)
    loginAttempts.shift();
  if (loginAttempts.length >= 10)
    throw new lib.Problem(429, "Too many attempts. Try again in a minute.");
  if (!isAdminToken(key)) {
    loginAttempts.push(now);
    throw new lib.Problem(401, "Invalid access key");
  }
  const secret = token();
  await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date().toISOString()));
  await db.insert(sessions).values({
    hash: lib.sha256(secret),
    expiresAt: new Date(now + 86400000).toISOString(),
  });
  setCookie(c, "skillbox_session", secret, {
    httpOnly: true,
    secure: origin().startsWith("https:"),
    sameSite: "Strict",
    path: "/",
    maxAge: 86400,
  });
  return c.json({ ok: true });
});
app.post("/api/logout", async (c) => {
  const value = getCookie(c, "skillbox_session");
  if (value)
    await db.delete(sessions).where(eq(sessions.hash, lib.sha256(value)));
  deleteCookie(c, "skillbox_session", { path: "/" });
  return c.json({ ok: true });
});
app.use("/api/*", async (c, next) => {
  c.set("principal", await authenticate(c.req.raw, true));
  await next();
});
app.get("/api/settings/ai-gateway", async (c) => {
  assertAdmin(c.get("principal"));
  return c.json(await gateway.gatewaySettings());
});
app.put("/api/settings/ai-gateway", async (c) => {
  assertAdmin(c.get("principal"));
  return c.json(
    await gateway.configureGateway(
      gateway.gatewayInput.parse(await c.req.json()),
    ),
  );
});
app.get("/api/me", (c) =>
  c.json({ name: c.get("principal").name, role: c.get("principal").role }),
);
app.put("/api/bundles/:id", async (c) => {
  const b = z
    .object({
      title: z.string().min(1).max(160),
      description: z.string().min(1).max(3000),
      members: z.array(z.string()).max(200),
      expectedRevision: z.string().nullable(),
    })
    .parse(await c.req.json());
  return c.json(
    await lib.saveBundle(
      c.get("principal"),
      c.req.param("id"),
      b.title,
      b.description,
      b.members,
      b.expectedRevision,
    ),
  );
});
app.get("/api/skills", async (c) => {
  const q = z
    .object({
      query: z.string().max(300).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      offset: z.coerce.number().int().nonnegative().optional(),
      includeArchived: z.enum(["true", "false"]).optional(),
      includeDisabled: z.enum(["true", "false"]).optional(),
      kind: z.enum(["skill", "bundle", "all"]).optional(),
      metrics: z.enum(["true", "false"]).optional(),
    })
    .parse(c.req.query());
  const kinds: ("skill" | "bundle")[] =
    q.kind === "skill"
      ? ["skill"]
      : q.kind === "bundle"
        ? ["bundle"]
        : ["skill", "bundle"];
  return c.json(
    await lib.search(
      c.get("principal"),
      q.query,
      q.limit,
      q.offset,
      q.includeArchived === "true",
      q.includeDisabled === "true",
      kinds,
      q.metrics === "true",
    ),
  );
});
app.post("/api/skill-recommendations", async (c) => {
  const input = recommendationInput.parse(await c.req.json());
  return c.json(
    await lib.recommendSkills(
      () => authenticate(c.req.raw, true),
      input,
      c.req.raw.signal,
    ),
  );
});
app.post("/api/imports/github/preview", async (c) => {
  const principal = c.get("principal");
  assertAdmin(principal);
  const prepared = await prepareGitHubImport(
    githubImportInput.parse(await c.req.json()),
    c.req.raw.signal,
  );
  if (prepared.kind === "catalog") return c.json(prepared);
  const [existing] = await db
    .select()
    .from(skills)
    .where(eq(skills.id, prepared.id));
  if (
    existing &&
    (existing.kind !== "skill" || existing.disabled || existing.archived)
  )
    throw new lib.Problem(
      409,
      "Existing entry is a bundle, disabled or archived; resolve that before importing",
    );
  return c.json({
    ...prepared,
    files: prepared.files.map(({ content, ...file }) => file),
    expectedRevision: existing?.revision ?? null,
  });
});
app.post("/api/imports/github/publish", async (c) => {
  const principal = c.get("principal");
  assertAdmin(principal);
  const input = z
    .object({
      url: z.string().max(2048),
      id: z.string().max(80),
      expectedRevision: z.string().nullable(),
    })
    .strict()
    .parse(await c.req.json());
  const target = parseGitHubUrl(input.url);
  if (
    target.kind !== "tree" ||
    !/^[0-9a-f]{40}$/.test(target.segments[0] ?? "")
  )
    throw new lib.Problem(
      400,
      "Preview first; publishing requires a commit-pinned GitHub URL",
    );
  const prepared = await prepareGitHubImport(
    { url: input.url },
    c.req.raw.signal,
  );
  if (prepared.kind !== "skill" || prepared.id !== input.id)
    throw new lib.Problem(400, "Preview and imported skill do not match");
  const [existing] = await db
    .select()
    .from(skills)
    .where(eq(skills.id, prepared.id));
  if (
    existing &&
    (existing.kind !== "skill" || existing.disabled || existing.archived)
  )
    throw new lib.Problem(
      409,
      "Existing entry is a bundle, disabled or archived; resolve that before importing",
    );
  return c.json(
    await lib.publish(
      principal,
      prepared.id,
      prepared.files,
      input.expectedRevision,
      `Import ${prepared.source.repository}@${prepared.source.commit.slice(0, 12)}`,
      undefined,
      { source: prepared.source },
    ),
  );
});
app.get("/api/skill-compatibility", async (c) => {
  const { offset } = z
    .object({
      offset: z.coerce.number().int().min(0).max(99_999_999).default(0),
    })
    .parse(c.req.query());
  return c.json(await compatibilityPage(c.get("principal"), offset));
});
app.get("/api/skills/:id/manifest", async (c) =>
  c.json(await manifestFor(c.get("principal"), c.req.param("id"))),
);
app.get("/api/skill-references/:referenceId", async (c) =>
  c.json(
    await lib.resolveSkillReference(
      c.get("principal"),
      c.req.param("referenceId"),
    ),
  ),
);
app.get("/api/skills/:id", async (c) =>
  c.json(
    await lib.load(
      c.get("principal"),
      c.req.param("id"),
      c.req.query("revision"),
    ),
  ),
);
app.get("/api/skills/:id/file", async (c) => {
  const { revision, path } = z
    .object({ revision: z.string(), path: z.string() })
    .parse(c.req.query());
  return c.json(
    await lib.readFile(c.get("principal"), c.req.param("id"), revision, path),
  );
});
app.get("/api/skills/:id/bundle", async (c) => {
  const r = await lib.revisionFor(
    c.get("principal"),
    c.req.param("id"),
    c.req.query("revision"),
  );
  await lib.record(c.get("principal"), "bundle", r.skillId, { revision: r.id });
  return c.json({
    format: "skillbox/v1",
    id: r.skillId,
    revision: r.id,
    checksum: r.checksum,
    files: asSkillFiles(await withContent(r.files)),
  });
});
app.get("/api/skills/:id/history", async (c) =>
  c.json(await lib.history(c.get("principal"), c.req.param("id"))),
);
app.patch("/api/skills/:id/icon", async (c) => {
  const body = z
    .object({ icon: z.unknown(), expectedRevision: z.string() })
    .parse(await c.req.json());
  let icon;
  try {
    icon = parseSkillIcon(body.icon);
  } catch (e) {
    throw new lib.Problem(400, (e as Error).message);
  }
  return c.json(
    await lib.setIcon(
      c.get("principal"),
      c.req.param("id"),
      icon,
      body.expectedRevision,
    ),
  );
});
app.patch("/api/skills/:id/status", async (c) => {
  const body = z
    .object({ disabled: z.boolean(), expectedRevision: z.string() })
    .parse(await c.req.json());
  return c.json(
    await lib.setDisabled(
      c.get("principal"),
      c.req.param("id"),
      body.disabled,
      body.expectedRevision,
    ),
  );
});
app.put("/api/skills/:id", async (c) => {
  const body = z
    .object({
      expectedRevision: z.string().nullable(),
      files: z.array(fileSchema).max(400),
      message: z.string().max(200).optional(),
    })
    .parse(await c.req.json());
  return c.json(
    await lib.publish(
      c.get("principal"),
      c.req.param("id"),
      body.files,
      body.expectedRevision,
      body.message,
    ),
  );
});
app.post("/api/import/skills/:id/revisions", async (c) => {
  assertAdmin(c.get("principal"));
  const body = z
    .object({
      referenceId: z.string(),
      previous: z.string().nullable(),
      revision: z.object({
        id: z.string().max(80),
        message: z.string().max(2000),
        author: z.string().max(2000),
        createdAt: z.string().datetime({ offset: true }),
        checksum: z.string().length(64),
        source: z.any().optional(),
      }),
      files: z.array(fileSchema).max(400),
    })
    .strict()
    .parse(await c.req.json());
  return c.json(
    await lib.importRevision(c.get("principal"), c.req.param("id"), {
      ...body,
      revision: {
        ...body.revision,
        createdAt: new Date(body.revision.createdAt).toISOString(),
      },
    }),
  );
});
app.post("/api/skills/:id/restore", async (c) => {
  const body = z
    .object({ revision: z.string(), expectedRevision: z.string() })
    .parse(await c.req.json());
  const r = await lib.revisionFor(
    c.get("principal"),
    c.req.param("id"),
    body.revision,
  );
  return c.json(
    await lib.publish(
      c.get("principal"),
      r.skillId,
      asSkillFiles(await withContent(r.files)),
      body.expectedRevision,
      "Restore " + r.id.slice(0, 8),
      undefined,
      { source: r.source ?? undefined },
    ),
  );
});
app.get("/api/profiles", async (c) => {
  assertAdmin(c.get("principal"));
  return c.json(await db.select().from(profiles).orderBy(profiles.name));
});
app.post("/api/profiles", async (c) =>
  c.json(
    await access.saveProfile(
      c.get("principal"),
      access.profileSchema.parse(await c.req.json()),
    ),
  ),
);
app.put("/api/profiles/:id", async (c) => {
  const body = access.profileSchema
    .extend({ version: z.string() })
    .parse(await c.req.json());
  return c.json(
    await access.saveProfile(
      c.get("principal"),
      body,
      c.req.param("id"),
      body.version,
    ),
  );
});
app.delete("/api/profiles/:id", async (c) => {
  assertAdmin(c.get("principal"));
  const id = c.req.param("id");
  // One conditional statement instead of a locked read + delete.
  const deleted = await db
    .delete(profiles)
    .where(
      and(
        eq(profiles.id, id),
        sql`NOT EXISTS (SELECT 1 FROM clients WHERE clients.profile_id=${id})`,
      ),
    )
    .returning({ id: profiles.id });
  if (
    !deleted.length &&
    (await db.select().from(clients).where(eq(clients.profileId, id))).length
  )
    throw new lib.Problem(
      409,
      "Reassign this profile’s clients before deleting it",
    );
  return c.json({ ok: true });
});
app.get("/api/clients", async (c) => {
  assertAdmin(c.get("principal"));
  return c.json(
    await db
      .select({
        id: clients.id,
        name: clients.name,
        profileId: clients.profileId,
        active: clients.active,
        createdAt: clients.createdAt,
        lastSeen: sql<
          string | null
        >`(SELECT max(events.created_at) FROM events WHERE events.client_id=clients.id)`,
      })
      .from(clients)
      .orderBy(clients.name),
  );
});
app.post("/api/clients", async (c) => {
  assertAdmin(c.get("principal"));
  const b = z
    .object({
      name: z.string().trim().min(1).max(80),
      profileId: z.string().min(1),
    })
    .strict()
    .parse(await c.req.json());
  return c.json(await access.uniqueClient(b.name, b.profileId));
});
app.patch("/api/clients/:id", async (c) => {
  assertAdmin(c.get("principal"));
  const b = z
    .object({
      active: z.boolean().optional(),
      profileId: z.string().optional(),
      name: z.string().trim().min(1).max(80).optional(),
    })
    .strict()
    .parse(await c.req.json());
  if (
    b.profileId &&
    !(await db.select().from(profiles).where(eq(profiles.id, b.profileId)))
      .length
  )
    throw new lib.Problem(404, "Profile not found");
  // The partial unique index on active client names replaces the advisory lock.
  const [current] = await db
    .select()
    .from(clients)
    .where(eq(clients.id, c.req.param("id")));
  if (!current) throw new lib.Problem(404, "Client not found");
  try {
    await db
      .update(clients)
      .set({ ...b, ...(b.name ? { nameKey: nameKey(b.name) } : {}) })
      .where(eq(clients.id, current.id));
  } catch (e) {
    if (uniqueViolation(e, "clients.name_key"))
      throw new lib.Problem(409, "An active client already has this name");
    throw e;
  }
  return c.json({ ok: true });
});
app.post("/api/skills/:id/proposals", async (c) => {
  const b = z
    .object({
      files: z.array(fileSchema).max(400),
      expectedRevision: z.string(),
      message: z.string().trim().min(1).max(200),
    })
    .parse(await c.req.json());
  return c.json(
    await access.propose(
      c.get("principal"),
      c.req.param("id"),
      b.files,
      b.expectedRevision,
      b.message,
    ),
  );
});
app.get("/api/proposals", async (c) =>
  c.json(await access.listProposals(c.get("principal"))),
);
app.get("/api/proposals/:id", async (c) =>
  c.json(await access.proposalDetail(c.get("principal"), c.req.param("id"))),
);
app.post("/api/proposals/:id/review", async (c) => {
  const b = z
    .object({ decision: z.enum(["approve", "reject"]) })
    .parse(await c.req.json());
  return c.json(
    await access.reviewProposal(
      c.get("principal"),
      c.req.param("id"),
      b.decision,
    ),
  );
});
app.delete("/api/skills/:id", async (c) => {
  const b = z
    .object({ expectedRevision: z.string() })
    .parse(await c.req.json());
  return c.json(
    await lib.archiveSkill(
      c.get("principal"),
      c.req.param("id"),
      b.expectedRevision,
    ),
  );
});
app.get("/api/settings/executor", async (c) => {
  assertAdmin(c.get("principal"));
  return c.json(await executor.executorSettings());
});
app.put("/api/settings/executor", async (c) => {
  assertAdmin(c.get("principal"));
  const b = z
    .object({
      endpoint: z.string().url().max(2048),
      bearer: z.string().max(8192).optional(),
    })
    .parse(await c.req.json());
  return c.json(await executor.configureExecutor(b.endpoint, b.bearer));
});
app.post("/api/executor/connect", async (c) => {
  assertAdmin(c.get("principal"));
  return c.json(await executor.authorizeExecutor());
});
app.post("/api/executor/disconnect", async (c) => {
  assertAdmin(c.get("principal"));
  return c.json(await executor.disconnectExecutor());
});
app.get("/api/executor/callback", async (c) => {
  assertAdmin(c.get("principal"));
  const code = c.req.query("code"),
    state = c.req.query("state");
  if (!code || !state)
    throw new lib.Problem(400, "Authorization was not completed");
  await executor.authorizeExecutor(code, state);
  return c.redirect("/settings");
});
app.get("/api/executor/integrations", async (c) => {
  assertAdmin(c.get("principal"));
  return c.json(
    await executor.executorCatalog(c.req.query("refresh") === "true"),
  );
});
app.get("/api/events", async (c) => {
  assertAdmin(c.get("principal"));
  const q = z
    .object({
      skillId: z.string().optional(),
      operation: z.enum(["reads", "usage", "legacy", "web"]).optional(),
      offset: z.coerce.number().int().min(0).default(0),
    })
    .parse(c.req.query());
  const filters = [];
  if (q.skillId) filters.push(eq(events.skillId, q.skillId));
  if (q.operation === "usage")
    filters.push(eq(events.operation, "reported_use"));
  if (q.operation === "reads")
    filters.push(
      sql`${events.operation} IN ('load','read_file','bundle') AND ${events.context}->>'source' IN ('mcp','cli')`,
    );
  if (q.operation === "legacy")
    filters.push(sql`COALESCE(${events.context}->>'source','legacy')='legacy'`);
  if (q.operation === "web")
    filters.push(sql`${events.context}->>'source'='web'`);
  return c.json(
    await db
      .select()
      .from(events)
      .where(and(...filters))
      .orderBy(desc(events.createdAt), events.id)
      .limit(100)
      .offset(q.offset),
  );
});
app.patch("/api/skills/:id/integrations", async (c) => {
  const body = z
    .object({
      integrations: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)).max(30),
      expectedRevision: z.string(),
    })
    .parse(await c.req.json());
  return c.json(
    await lib.setIntegrations(
      c.get("principal"),
      c.req.param("id"),
      body.integrations,
      body.expectedRevision,
    ),
  );
});
// CORS for /mcp: browser clients on other origins (a chat page running its backend in the
// page, an artifact) call MCP directly. Auth is the Bearer key, never a cookie, so a page
// without the key gets nothing: "*" without credentials is safe, and the Origin check stays
// for key-less requests. Error responses carry the headers too — otherwise the browser
// hides a 401 behind an opaque network error.
const MCP_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name, last-event-id",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
  "Access-Control-Max-Age": "86400",
};
app.options("/mcp", () => new Response(null, { status: 204, headers: MCP_CORS }));
app.use("/mcp", async (c, next) => {
  await next();
  c.res = new Response(c.res.body, c.res);
  for (const [k, v] of Object.entries(MCP_CORS)) c.res.headers.set(k, v);
});
app.post("/mcp", async (c) => {
  const provided = c.req.header("Origin");
  const keyed = /^Bearer \S/i.test(c.req.header("authorization") ?? "");
  if (provided && !keyed && !allowedOrigins().has(provided))
    throw new lib.Problem(403, "Origin not allowed");
  return handleMcp(c.req.raw, await authenticate(c.req.raw));
});
app.on(["GET", "DELETE"], "/mcp", async (c) => {
  await authenticate(c.req.raw);
  return c.json({ error: "Use POST for stateless MCP" }, 405);
});
// Link sharing ("anyone with the link"): /s/<shareId> → SKILL.md of the latest revision,
// /s/<shareId>/<path> → a file; a bundle exposes its members as /s/<shareId>/~<member>/<path>.
// The link grants read access to that one skill (and a bundle's members) and nothing else.
const shareToken = () => randomBytes(18).toString("base64url");
async function activeShare(skillId: string) {
  const [row] = await db
    .select()
    .from(skillShares)
    .where(and(eq(skillShares.skillId, skillId), isNull(skillShares.revokedAt)));
  return row ?? null;
}
app.get("/api/skills/:id/share", async (c) => {
  assertAdmin(c.get("principal"));
  const row = await activeShare(c.req.param("id"));
  return c.json({ shareId: row?.id ?? null, createdAt: row?.createdAt ?? null });
});
app.post("/api/skills/:id/share", async (c) => {
  assertAdmin(c.get("principal"));
  const r = await lib.revisionFor(c.get("principal"), c.req.param("id"));
  await db
    .update(skillShares)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(skillShares.skillId, r.skillId), isNull(skillShares.revokedAt)));
  const id = shareToken();
  await db.insert(skillShares).values({ id, skillId: r.skillId });
  return c.json({ shareId: id });
});
app.delete("/api/skills/:id/share", async (c) => {
  assertAdmin(c.get("principal"));
  await db
    .update(skillShares)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(skillShares.skillId, c.req.param("id")), isNull(skillShares.revokedAt)));
  return c.json({ ok: true });
});
const sharedRead = async (c: any, shareId: string, rest: string) => {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(shareId)) throw new lib.Problem(404, "Link not found");
  const [share] = await db
    .select()
    .from(skillShares)
    .where(and(eq(skillShares.id, shareId), isNull(skillShares.revokedAt)));
  if (!share) throw new lib.Problem(404, "Link not found");
  const p: Principal = {
    id: "share:" + shareId.slice(0, 6),
    name: "link " + share.skillId,
    role: "reader",
    allSkills: false,
    skillIds: [share.skillId],
    context: { source: "link" },
  };
  let id = share.skillId,
    path = rest || "SKILL.md",
    base = `${new URL(c.req.url).origin}/s/${shareId}`;
  const member = path.match(/^~([a-z0-9][a-z0-9-]{0,79})(?:\/(.*))?$/);
  if (member) {
    id = member[1];
    path = member[2] || "SKILL.md";
    base += "/~" + id;
  }
  const r = await lib.revisionFor(p, id);
  let text = (await lib.readFile(p, r.skillId, r.id, path)).text;
  if (path === "SKILL.md") {
    const others = r.files
      .map((x: { path: string }) => x.path)
      .filter((x: string) => x !== "SKILL.md" && !isIconAsset(x));
    const members: string[] =
      r.metadata.kind === "bundle" ? (r.metadata.members ?? []) : [];
    text +=
      `\n\n---\nskillbox: ${r.skillId}@${r.id}. Relative paths above resolve against ${base}/\n` +
      (others.length ? `Files:\n${others.map((x: string) => `- ${base}/${x}`).join("\n")}\n` : "") +
      (members.length
        ? `Bundle members:\n${members.map((m) => `- ${new URL(c.req.url).origin}/s/${shareId}/~${m}`).join("\n")}\n`
        : "");
  }
  c.header("Content-Type", "text/markdown; charset=utf-8");
  return c.body(text);
};
app.get("/s/:share", (c) => sharedRead(c, c.req.param("share"), ""));
app.get("/s/:share/*", (c) => {
  const share = c.req.param("share");
  return sharedRead(c, share, decodeURIComponent(c.req.path.slice(`/s/${share}/`.length)));
});
app.get("/bootstrap/SKILL.md", async (c) =>
  c.text(await required(c, "bootstrap/SKILL.md")),
);
app.get("/cli/skillbox.mjs", async (c) => {
  c.header("Content-Type", "text/javascript");
  return c.body(await required(c, "cli/skillbox.mjs"));
});
app.get("/cli/package.mjs", async (c) => {
  c.header("Content-Type", "text/javascript");
  return c.body(await required(c, "cli/package.mjs"));
});
app.use("/assets/*", async (c, next) => (await files(c)).assets(c, next));
app.get("/favicon.svg", async (c) => {
  const f = await (await files(c)).text("favicon.svg");
  if (f === null) return c.notFound();
  c.header("Content-Type", "image/svg+xml");
  c.header("Cache-Control", "public, max-age=86400");
  return c.body(f);
});
app.get("*", async (c) => {
  const f = await (await files(c)).text("index.html");
  return f !== null
    ? c.html(f)
    : c.text("Skillbox API is running. Build the web UI to open the library.");
});
