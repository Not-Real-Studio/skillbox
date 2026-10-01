import {
  REFERENCE_ID,
  referenceId,
  extractSkillReferences,
} from "../skill-references";
import { packageMetrics } from "../package-metrics";
import { parseSkillIcon, type SkillIcon } from "../skill-icons";
import { createHash, randomUUID } from "node:crypto";
import matter from "gray-matter";
import { and, eq, desc, getTableColumns, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { d1, db } from "./db";
import { skills, revisions, events } from "./schema";
import { asSkillFiles, storeFiles, withContent } from "./files";
import type {
  Principal,
  SkillFile,
  SkillMetadata,
  GitHubSource,
} from "../shared";
import { expandBundles } from "./bundles";
import { gatewayRecommender, gatewaySettings } from "./gateway";
import {
  MAX_CANDIDATES,
  recommend,
  type Candidate,
  type Catalog,
} from "./recommendations";
export class Problem extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const sha256 = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
/** column IN list via one JSON parameter: D1 allows at most 100 bound parameters. */
export const inList = (column: SQLiteColumn | SQL, values: string[]) =>
  sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;
// Graph checks and listings never need search_text (up to hundreds of KB per skill).
const { searchText: _searchText, ...nodeColumns } = getTableColumns(skills);
const graphColumns = {
  id: skills.id,
  kind: skills.kind,
  members: skills.members,
  archived: skills.archived,
  disabled: skills.disabled,
  replacement: skills.replacement,
  revision: skills.revision,
};
export const ADMIN: Principal = {
  id: "admin",
  name: "Administrator",
  role: "admin",
  allSkills: true,
  skillIds: [],
};
export function validId(id: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id))
    throw new Problem(400, "Invalid skill ID");
  return id;
}
export function safePath(path: string) {
  if (
    !path ||
    path.length > 240 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\x00-\x1f:]/.test(path) ||
    path.split("/").some((x) => !x || x === "." || x === "..")
  )
    throw new Problem(400, "Invalid file path");
  return path;
}
export function validateFiles(files: SkillFile[]) {
  if (!Array.isArray(files) || !files.length || files.length > 400)
    throw new Problem(400, "Expected 1–400 files");
  let total = 0;
  const seen = new Set<string>();
  for (const f of files) {
    safePath(f.path);
    const key = f.path.normalize("NFC").toLowerCase();
    if (seen.has(key)) throw new Problem(400, "Duplicate file path");
    seen.add(key);
    if (
      typeof f.content !== "string" ||
      f.content.length > 3_000_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        f.content,
      )
    )
      throw new Problem(400, "Invalid file encoding");
    const bytes = Buffer.from(f.content, "base64");
    if (
      bytes.toString("base64") !== f.content ||
      bytes.length !== f.size ||
      sha256(bytes) !== f.sha256
    )
      throw new Problem(400, "File checksum mismatch");
    if (bytes.length > 2_000_000)
      throw new Problem(400, "Files are limited to 2 MB");
    total += bytes.length;
    if (typeof f.executable !== "boolean")
      throw new Problem(400, "Invalid executable flag");
  }
  if (total > 8_000_000) throw new Problem(400, "Skill is limited to 8 MB");
  for (const p of seen)
    for (const other of seen)
      if (other.startsWith(p + "/"))
        throw new Problem(400, "File path conflicts with directory");
  if (!files.some((f) => f.path === "SKILL.md"))
    throw new Problem(400, "SKILL.md is required");
}
export function metadata(id: string, files: SkillFile[]): SkillMetadata {
  const text = Buffer.from(
    files.find((f) => f.path === "SKILL.md")!.content,
    "base64",
  ).toString("utf8");
  let data: Record<string, unknown>;
  try {
    data = matter(text).data;
  } catch {
    // Legacy libraries often have unquoted colons inside description scalars.
    // Parse a normalized header while keeping the stored source bytes unchanged.
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) throw new Problem(400, "Invalid Markdown frontmatter");
    const header = match[1].replace(
      /^(description|shortDescription):\s+([^\n]+)$/gm,
      (line, key, value) =>
        /^["'|>\[{]/.test(value) ? line : key + ": " + JSON.stringify(value),
    );
    try {
      data = matter("---\n" + header + "\n---\n").data;
    } catch {
      throw new Problem(400, "Invalid Markdown frontmatter");
    }
  }
  if (data.name && data.name !== id)
    throw new Problem(400, "Frontmatter name must match the skill ID");
  const title = String(data.displayName ?? data.title ?? id),
    description = String(data.description ?? "");
  if (!description.trim() || description.length > 3000)
    throw new Problem(400, "A description of 1–3000 characters is required");
  const tags = [
    ...new Set(
      [
        data.group,
        data.category,
        ...(Array.isArray(data.tags) ? data.tags : []),
      ].filter((x) => typeof x === "string" && x.length < 80),
    ),
  ] as string[];
  const kind = data.kind ?? "skill";
  if (kind !== "skill" && kind !== "bundle")
    throw new Problem(400, "Kind must be skill or bundle");
  if (
    data.members !== undefined &&
    (!Array.isArray(data.members) ||
      data.members.length > 200 ||
      data.members.some((x) => typeof x !== "string"))
  )
    throw new Problem(
      400,
      "Members must be an array of up to 200 skill or bundle IDs",
    );
  const members = [...new Set((data.members ?? []) as string[])].map(validId);
  if (kind === "skill" && members.length)
    throw new Problem(400, "Only bundles can have members");
  if (data.archived !== undefined && typeof data.archived !== "boolean")
    throw new Problem(400, "Archived must be a boolean");
  if (data.disabled !== undefined && typeof data.disabled !== "boolean")
    throw new Problem(400, "Disabled must be a boolean");
  const replacement =
    data.replacement === undefined ? null : validId(String(data.replacement));
  if (replacement === id)
    throw new Problem(400, "A skill cannot replace itself");
  const executorIntegrations = data.executorIntegrations ?? [];
  if (
    !Array.isArray(executorIntegrations) ||
    executorIntegrations.length > 30 ||
    executorIntegrations.some(
      (x: unknown) =>
        typeof x !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(x),
    )
  )
    throw new Problem(400, "Invalid Executor integrations");
  return {
    executorIntegrations: [...new Set(executorIntegrations)] as string[],
    kind,
    members,
    archived: data.archived === true,
    disabled: data.disabled === true,
    replacement,
    name: id,
    title,
    description,
    tags,
    requirements:
      typeof data.requirements === "object" && data.requirements
        ? (data.requirements as Record<string, unknown>)
        : {},
    frontmatter: data,
    icon: resolveIcon(data.icon, files),
  };
}
export async function authorizedIds(p: Principal) {
  return expandBundles(await db.select(graphColumns).from(skills), p.skillIds);
}
export async function canRead(p: Principal, id: string) {
  if (p.role === "admin") return true;
  const [current] = await db
    .select({ disabled: skills.disabled })
    .from(skills)
    .where(eq(skills.id, id));
  if (current?.disabled) return false;
  return (
    p.allSkills ||
    p.skillIds.includes(id) ||
    (await authorizedIds(p)).includes(id)
  );
}
const grantFilter = async (p: Principal) => {
  if (p.allSkills) return sql`true`;
  const ids = await authorizedIds(p);
  return ids.length ? inList(skills.id, ids) : sql`false`;
};
export async function record(
  p: Principal,
  operation: string,
  skillId?: string,
  context: import("../shared").AccessContext = {},
) {
  await db.insert(events).values({
    id: randomUUID(),
    clientId: p.id,
    clientName: p.name,
    context: {
      source: p.context?.source ?? "legacy",
      ...p.context,
      ...context,
    },
    operation,
    skillId,
  });
}
const agentRead = sql`e.operation IN ('load','read_file','bundle') AND e.context->>'source' IN ('mcp','cli')`;
export async function search(
  p: Principal,
  query = "",
  limit?: number,
  offset = 0,
  includeArchived = false,
  includeDisabled = false,
  kinds: ("skill" | "bundle")[] = ["skill"],
  includeMetrics = false,
) {
  query = query.trim().slice(0, 300);
  const count = Math.min(limit ?? (query ? 20 : 500), 500);
  offset = Math.max(offset, 0);
  const conditions = [await grantFilter(p)];
  conditions.push(kinds.length ? inList(skills.kind, kinds) : sql`false`);
  if (!(includeArchived && p.role === "admin"))
    conditions.push(eq(skills.archived, false));
  if (!(includeDisabled && p.role === "admin"))
    conditions.push(eq(skills.disabled, false));
  // FTS5 (skills_fts): every word must match, as a prefix — unicode61 has no
  // stemming outside English, so "навык" also finds "навыки". Plus substring
  // match on id and description, like the former ILIKE.
  const words = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 32) ?? [];
  const fts = words.length ? words.map((w) => `"${w}"*`).join(" ") : null;
  const like = "%" + query.replace(/[!%_]/g, (c) => "!" + c) + "%";
  if (query)
    conditions.push(
      sql`(${fts ? sql`${skills.id} IN (SELECT id FROM skills_fts WHERE skills_fts MATCH ${fts})` : sql`false`} OR ${skills.id} LIKE ${like} ESCAPE '!' OR ${skills.description} LIKE ${like} ESCAPE '!')`,
    );
  const rows = await db
    .select(nodeColumns)
    .from(skills)
    .where(and(...conditions))
    .orderBy(
      // bm25() is lower for better matches; substring-only hits rank last.
      fts
        ? sql`COALESCE((SELECT bm25(skills_fts) FROM skills_fts WHERE skills_fts MATCH ${fts} AND skills_fts.id=${skills.id}), 0)`
        : skills.id,
      skills.id,
    )
    .limit(count + 1)
    .offset(offset);
  const hasMore = rows.length > count;
  const page = rows.slice(0, count);
  const metrics =
    includeMetrics && p.role === "admin" && page.length
      ? await db.all<Record<string, unknown>>(sql`
      SELECT s.id,s.package_metrics,
        (SELECT created_at FROM events e WHERE e.skill_id=s.id AND ${agentRead} ORDER BY created_at DESC LIMIT 1) AS "lastAgentReadAt",
        (SELECT client_name FROM events e WHERE e.skill_id=s.id AND ${agentRead} ORDER BY created_at DESC LIMIT 1) AS "lastAgentReadBy",
        (SELECT created_at FROM events e WHERE e.skill_id=s.id AND e.operation='reported_use' ORDER BY created_at DESC LIMIT 1) AS "lastUsedAt",
        (SELECT count(*) FROM events e WHERE e.skill_id=s.id AND ${agentRead}) AS "readCount",
        (SELECT count(*) FROM events e WHERE e.skill_id=s.id AND e.operation='reported_use') AS "usageCount"
      FROM skills s
      WHERE ${inList(
        sql`s.id`,
        page.map((s) => s.id),
      )}
    `)
      : [];
  const byId = new Map(
    metrics.map(({ package_metrics, ...m }) => [
      m.id as string,
      {
        ...m,
        ...(package_metrics ? JSON.parse(package_metrics as string) : {}),
      },
    ]),
  );
  const items: import("../shared").SkillSummary[] = page.map(
    ({ packageMetrics: _, ...row }) => ({
      ...row,
      ...byId.get(row.id),
    }),
  );
  await record(p, query ? "search" : "browse");
  return { items, hasMore, nextOffset: hasMore ? offset + count : null };
}
// Only compact, authorized, active leaf descriptions can leave this server.
export async function recommendationCatalog(p: Principal): Promise<Catalog> {
  const candidates = await db
    .select({
      id: skills.id,
      referenceId: skills.referenceId,
      revision: skills.revision,
      description: skills.description,
    })
    .from(skills)
    .where(
      and(
        await grantFilter(p),
        eq(skills.kind, "skill"),
        eq(skills.archived, false),
        eq(skills.disabled, false),
      ),
    )
    .orderBy(skills.id)
    .limit(MAX_CANDIDATES + 1);
  return {
    scope: JSON.stringify([
      p.id,
      p.profileId,
      p.role,
      p.allSkills,
      [...p.skillIds].sort(),
    ]),
    candidates,
  };
}
export async function recommendSkills(
  principal: () => Promise<Principal>,
  input: Parameters<typeof recommend>[1],
  signal?: AbortSignal,
  rank?: typeof recommend,
) {
  const configured = rank ? undefined : await gatewayRecommender();
  const engine = rank ?? configured!.rank;
  const result = await engine(
    {
      catalog: async () => {
        const catalog = await recommendationCatalog(await principal());
        if (!rank) {
          const settings = await gatewaySettings();
          catalog.scope += ":" + settings.provider + ":" + settings.revision;
        }
        return catalog;
      },
      search: async (task, limit, offset) => {
        const page = await search(await principal(), task, limit, offset);
        return {
          ...page,
          items: page.items.map((s): Candidate => ({
            id: s.id,
            referenceId: s.referenceId!,
            revision: s.revision,
            description: s.description,
          })),
        };
      },
    },
    input,
    signal,
  );
  await record(await principal(), "recommend");
  return {
    ...result,
    ...(configured ? { provider: configured.provider } : {}),
  };
}
export async function revisionFor(p: Principal, id: string, revision?: string) {
  id = await resolveReferenceId(id);
  if (!(await canRead(p, id)))
    throw new Problem(404, "Skill or revision not found");
  const [s] = await db.select().from(skills).where(eq(skills.id, id));
  if (!s) throw new Problem(404, "Skill or revision not found");
  const [r] = await db
    .select()
    .from(revisions)
    .where(
      and(eq(revisions.id, revision ?? s.revision), eq(revisions.skillId, id)),
    );
  if (!r) throw new Problem(404, "Skill or revision not found");
  return r;
}
export async function load(p: Principal, id: string, revision?: string) {
  id = await resolveReferenceId(id);
  const r = await revisionFor(p, id, revision);
  let composition;
  if (r.metadata.kind === "bundle") {
    const nodes = await db.select(nodeColumns).from(skills);
    const root = nodes.find((n) => n.id === id)!;
    const graph = nodes.map((n) =>
      n.id === id
        ? {
            ...root,
            disabled: false,
            members: r.metadata.members,
            kind: "bundle" as const,
          }
        : n,
    );
    const allowed = p.allSkills ? null : new Set(await authorizedIds(p));
    const resolved = expandBundles(graph, [id]).filter(
      (child) => child !== id && (!allowed || allowed.has(child)),
    );
    const byId = new Map(nodes.map((n) => [n.id, n]));
    composition = {
      members: r.metadata.members.filter(
        (child) =>
          p.role === "admin" ||
          (resolved.includes(child) && (!allowed || allowed.has(child))),
      ),
      skills: resolved
        .map((child) => byId.get(child)!)
        .filter((n) => n.kind === "skill")
        .map(({ members, packageMetrics, ...n }) => n),
      bundles: resolved
        .map((child) => byId.get(child)!)
        .filter((n) => n.kind === "bundle")
        .map((n) => ({ id: n.id, revision: n.revision, title: n.title })),
      note: "Composition resolves current members once per load and deduplicates by ID. Load only relevant skills using the returned revisions; no skill instructions are loaded automatically.",
    };
  }
  await record(p, "load", id, { revision: r.id });
  const [current] = await db
    .select({ referenceId: skills.referenceId })
    .from(skills)
    .where(eq(skills.id, id));
  const [main] = await withContent(
    r.files.filter((f) => f.path === "SKILL.md"),
  );
  const instructions = Buffer.from(main.content, "base64").toString("utf8");
  return {
    id,
    referenceId: current!.referenceId,
    ...(await referenceDetails(p, instructions)),
    revision: r.id,
    checksum: r.checksum,
    source: r.source ?? null,
    metadata: { ...r.metadata, disabled: r.metadata.disabled ?? false },
    instructions,
    files: r.files.map(({ mime, ...f }) => f),
    ...(composition ? { composition } : {}),
    portability:
      "Fetch this exact revision on the execution host with skillbox fetch. Use returned directory as the base for relative references and bundled scripts. Historical absolute machine paths may need host-specific setup; fetching never installs dependencies.",
  };
}
export async function readFile(
  p: Principal,
  id: string,
  revision: string,
  path: string,
) {
  id = await resolveReferenceId(id);
  const r = await revisionFor(p, id, revision);
  safePath(path);
  const f = r.files.find((f) => f.path === path);
  if (!f) throw new Problem(404, "File not found");
  if (f.size > 160_000)
    throw new Problem(413, "File exceeds inline limit; fetch the bundle");
  const [stored] = await withContent([f]);
  const bytes = Buffer.from(stored.content, "base64");
  if (bytes.includes(0))
    throw new Problem(415, "Binary file; fetch the bundle");
  await record(p, "read_file", id, { revision: r.id, path });
  return {
    id,
    revision: r.id,
    path,
    text: bytes.toString("utf8"),
    ...(await referenceDetails(p, bytes.toString("utf8"))),
    sha256: f.sha256,
  };
}
const CHANGED =
  "This skill changed. Reload before saving; your edit has not been overwritten.";
const SEARCH_TEXT_LIMIT = 500_000;
// Bumped by every publish that changes bundle edges, lifecycle or replacement.
const graphGuard =
  "COALESCE((SELECT value FROM workspace_settings WHERE id='library_graph'),'')=?";
async function readGraphVersion() {
  const row = await d1
    .prepare("SELECT value FROM workspace_settings WHERE id='library_graph'")
    .first<{ value: string }>();
  return row?.value ?? "";
}
export function permits(
  p: Principal,
  capability: keyof import("../shared").Permissions,
) {
  return (
    p.role === "admin" ||
    (p.permissions
      ? p.permissions[capability]
      : p.role === "writer" &&
        (capability === "create" || capability === "update"))
  );
}
export async function publish(
  p: Principal,
  id: string,
  files: SkillFile[],
  expectedRevision: string | null,
  message = "Update skill",
  importReferenceId?: string,
  options: {
    archive?: boolean;
    source?: GitHubSource;
    /** Extra condition (SQL, params) the write requires; 409 with `conflict` otherwise. */
    guard?: { condition: string; params: unknown[]; conflict: string };
    /** Statements ending in a WHERE clause, run in the same batch only on success. */
    also?: { sql: string; params: unknown[] }[];
  } = {},
) {
  if (
    importReferenceId &&
    (p.role !== "admin" ||
      expectedRevision !== null ||
      !REFERENCE_ID.test(importReferenceId))
  )
    throw new Problem(
      400,
      "Reference IDs can only be restored for new entries by the owner",
    );
  validId(id);
  if (
    !permits(
      p,
      options.archive
        ? "delete"
        : expectedRevision === null
          ? "create"
          : "update",
    ) ||
    (expectedRevision !== null && !(await canRead(p, id))) ||
    (expectedRevision === null && !p.permissions && !(await canRead(p, id)))
  )
    throw new Problem(403, "Publishing is not allowed");
  validateFiles(files);
  const meta = metadata(id, files);
  const revision = randomUUID(),
    checksum = sha256(
      JSON.stringify(
        [...files]
          .sort((a, b) => a.path.localeCompare(b.path, "en-US"))
          .map((f) => [f.path, f.sha256, f.executable]),
      ),
    );
  // D1 has no interactive transactions or row locks. Files go to R2 first;
  // then one atomic batch whose first statement writes the skill row only if
  // it still has expectedRevision (and, for graph changes, the library graph
  // is unchanged since validation). Every later statement runs only if that
  // first write took effect, so a conflict changes nothing.
  const stored = await storeFiles(files);
  const [existing] = await db
    .select(graphColumns)
    .from(skills)
    .where(eq(skills.id, id));
  if ((existing?.revision ?? null) !== expectedRevision)
    throw new Problem(409, CHANGED);
  if (options.archive && (!existing || existing.kind !== "skill"))
    throw new Problem(403, "Only skills can be archived by this operation");
  const control = {
    kind: meta.kind,
    members: meta.members,
    archived: meta.archived,
    disabled: meta.disabled,
    replacement: meta.replacement,
  };
  const previous = {
    kind: existing?.kind ?? "skill",
    members: existing?.members ?? [],
    archived: options.archive ? true : (existing?.archived ?? false),
    disabled: existing?.disabled ?? false,
    replacement: existing?.replacement ?? null,
  };
  if (
    p.role !== "admin" &&
    JSON.stringify(control) !== JSON.stringify(previous)
  )
    throw new Problem(
      403,
      "Only the owner can change bundles, disabled state, archival or replacements",
    );
  // A new plain skill cannot invalidate other entries; edges, lifecycle and
  // replacement changes can, so those are validated against a graph version.
  const graphChange = existing
    ? JSON.stringify(control) !==
      JSON.stringify({
        kind: existing.kind,
        members: existing.members,
        archived: existing.archived,
        disabled: existing.disabled,
        replacement: existing.replacement,
      })
    : control.kind === "bundle" || control.replacement !== null;
  const graphVersion = graphChange ? await readGraphVersion() : null;
  const nodes = (await db.select(graphColumns).from(skills)).filter(
    (n) => n.id !== id,
  );
  const graph = [...nodes, { id, ...control }];
  if (
    meta.replacement &&
    !graph.some((n) => n.id === meta.replacement && !n.archived)
  )
    throw new Problem(400, "Replacement must be an active skill or bundle");
  try {
    expandBundles(
      graph,
      graph.filter((n) => n.kind === "bundle" && !n.archived).map((n) => n.id),
      true,
    );
  } catch (e) {
    throw new Problem(400, (e as Error).message);
  }
  // D1 rows are limited to 2 MB; search covers the first SEARCH_TEXT_LIMIT characters.
  const searchText = [
    id,
    meta.title,
    meta.description,
    meta.tags.join(" "),
    ...files
      .filter((f) => f.path.endsWith(".md"))
      .map((f) => Buffer.from(f.content, "base64").toString("utf8")),
  ]
    .join(" ")
    .slice(0, SEARCH_TEXT_LIMIT);
  const now = new Date().toISOString();
  const row = [
    meta.title,
    JSON.stringify(meta.icon ?? null),
    JSON.stringify(packageMetrics(files)),
    meta.description,
    JSON.stringify(meta.tags),
    control.kind,
    JSON.stringify(control.members),
    control.archived ? 1 : 0,
    control.disabled ? 1 : 0,
    control.replacement,
    revision,
    searchText,
    now,
  ];
  const guards = [
    ...(graphChange ? [graphGuard] : []),
    ...(options.guard ? [options.guard.condition] : []),
  ];
  const guardParams = [
    ...(graphChange ? [graphVersion ?? ""] : []),
    ...(options.guard?.params ?? []),
  ];
  const guardSql = guards.map((g) => ` AND ${g}`).join("");
  const write =
    expectedRevision === null
      ? d1
          .prepare(
            `INSERT INTO skills (title,icon,package_metrics,description,tags,kind,members,archived,disabled,replacement,revision,search_text,updated_at,id,reference_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM skills WHERE id=?)${guardSql}`,
          )
          .bind(
            ...row,
            id,
            importReferenceId ?? randomUUID(),
            id,
            ...guardParams,
          )
      : d1
          .prepare(
            `UPDATE skills SET title=?,icon=?,package_metrics=?,description=?,tags=?,kind=?,members=?,archived=?,disabled=?,replacement=?,revision=?,search_text=?,updated_at=? WHERE id=? AND revision=?${guardSql}`,
          )
          .bind(...row, id, expectedRevision, ...guardParams);
  const success = "EXISTS (SELECT 1 FROM skills WHERE id=? AND revision=?)";
  const statements = [
    write,
    d1
      .prepare(
        `INSERT INTO revisions (id,skill_id,metadata,files,source,checksum,message,author,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${success}`,
      )
      .bind(
        revision,
        id,
        JSON.stringify(meta),
        JSON.stringify(stored),
        options.source ? JSON.stringify(options.source) : null,
        checksum,
        message.slice(0, 200),
        p.name,
        now,
        id,
        revision,
      ),
    d1
      .prepare(
        `INSERT INTO events (id,client_id,client_name,operation,skill_id,context,created_at) SELECT ?,?,?,'publish',?,?,? WHERE ${success}`,
      )
      .bind(
        randomUUID(),
        p.id,
        p.name,
        id,
        JSON.stringify({ ...p.context, revision }),
        now,
        id,
        revision,
      ),
  ];
  if (!existing && p.profileId && !p.allSkills)
    // A newly created skill belongs to the creating profile.
    statements.push(
      d1
        .prepare(
          `UPDATE profiles SET skill_ids=json_insert(skill_ids,'$[#]',?),version=? WHERE id=? AND ${success}`,
        )
        .bind(id, randomUUID(), p.profileId, id, revision),
    );
  if (graphChange)
    statements.push(
      d1
        .prepare(
          `INSERT INTO workspace_settings (id,value) SELECT 'library_graph',? WHERE ${success} ON CONFLICT(id) DO UPDATE SET value=excluded.value`,
        )
        .bind(randomUUID(), id, revision),
    );
  for (const extra of options.also ?? [])
    statements.push(
      d1
        .prepare(`${extra.sql} AND ${success}`)
        .bind(...extra.params, id, revision),
    );
  const [result] = await d1.batch(statements);
  if (!result.meta.changes) {
    if (options.guard) {
      const check = await d1
        .prepare(`SELECT 1 AS ok WHERE ${options.guard.condition}`)
        .bind(...options.guard.params)
        .first();
      if (!check) throw new Problem(409, options.guard.conflict);
    }
    if (graphChange && (await readGraphVersion()) !== graphVersion)
      throw new Problem(
        409,
        "The library changed while saving. Reload and try again; your edit has not been saved.",
      );
    throw new Problem(409, CHANGED);
  }
  return { id, revision, checksum };
}
export async function history(p: Principal, id: string) {
  await revisionFor(p, id);
  return db
    .select({
      revision: revisions.id,
      message: revisions.message,
      author: revisions.author,
      createdAt: revisions.createdAt,
      checksum: revisions.checksum,
      source: revisions.source,
    })
    .from(revisions)
    .where(eq(revisions.skillId, id))
    .orderBy(desc(revisions.createdAt));
}
export function makeFile(
  path: string,
  text: string | Buffer,
  executable = false,
): SkillFile {
  const b = Buffer.from(text);
  return {
    path,
    content: b.toString("base64"),
    sha256: sha256(b),
    size: b.length,
    executable,
  };
}

export async function saveBundle(
  p: Principal,
  id: string,
  title: string,
  description: string,
  members: string[],
  expectedRevision: string | null,
) {
  if (p.role !== "admin")
    throw new Problem(403, "Administrator access required");
  const previous = expectedRevision
    ? await revisionFor(p, id, expectedRevision)
    : null;
  const previousFiles = previous
    ? asSkillFiles(await withContent(previous.files))
    : [];
  const frontmatter = {
    ...(previous?.metadata.frontmatter ?? {}),
    name: id,
    title,
    description,
    kind: "bundle",
    members,
  };
  const body = previous
    ? matter(
        Buffer.from(
          previousFiles.find((f) => f.path === "SKILL.md")!.content,
          "base64",
        ).toString("utf8"),
      ).content
    : `# ${title}\n\nLoad the relevant members from this bundle. Shared members appear once; instructions stay in their individual skills.\n`;
  const source = matter.stringify(body, frontmatter);
  const files = [
    ...previousFiles.filter((f) => f.path !== "SKILL.md"),
    makeFile("SKILL.md", source),
  ];
  return publish(p, id, files, expectedRevision, "Update bundle composition");
}

export async function setDisabled(
  p: Principal,
  id: string,
  disabled: boolean,
  expectedRevision: string,
) {
  if (p.role !== "admin")
    throw new Problem(403, "Only the owner can enable or disable entries");
  const previous = await revisionFor(p, id, expectedRevision);
  const files = asSkillFiles(await withContent(previous.files)).map((f) => {
    if (f.path !== "SKILL.md") return f;
    const source = Buffer.from(f.content, "base64").toString("utf8");
    const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
    return makeFile(
      f.path,
      matter.stringify(body, {
        ...previous.metadata.frontmatter,
        disabled,
      }),
      f.executable,
    );
  });
  return publish(
    p,
    id,
    files,
    expectedRevision,
    disabled ? "Disable entry" : "Enable entry",
  );
}

function resolveIcon(value: unknown, files: SkillFile[]) {
  try {
    const icon = value as SkillIcon | null;
    if (
      icon?.kind === "image" &&
      /^assets\/skillbox-icon\.(png|webp|jpeg)$/.test(icon.src)
    ) {
      const file = files.find((f) => f.path === icon.src);
      if (!file) throw new Error("Icon image file is missing");
      return parseSkillIcon({
        kind: "image",
        src: `data:image/${icon.src.split(".").pop()};base64,${file.content}`,
      });
    }
    return parseSkillIcon(value);
  } catch (e) {
    throw new Problem(400, (e as Error).message);
  }
}
export async function setIcon(
  p: Principal,
  id: string,
  icon: SkillIcon | null,
  expectedRevision: string,
) {
  if (!permits(p, "update"))
    throw new Problem(403, "Update permission required");
  const previous = await revisionFor(p, id, expectedRevision);
  let sourceIcon = icon;
  let asset: SkillFile | undefined;
  if (icon?.kind === "image") {
    const match = icon.src.match(/^data:image\/(png|webp|jpeg);base64,(.+)$/)!;
    const path = `assets/skillbox-icon.${match[1]}`;
    asset = {
      path,
      content: match[2],
      sha256: sha256(Buffer.from(match[2], "base64")),
      size: Buffer.from(match[2], "base64").length,
      executable: false,
    };
    sourceIcon = { kind: "image", src: path };
  }
  const files = asSkillFiles(await withContent(previous.files))
    .filter((f) => f.path !== asset?.path)
    .map((f) => {
      if (f.path !== "SKILL.md") return f;
      const source = Buffer.from(f.content, "base64").toString("utf8");
      const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
      return makeFile(
        f.path,
        matter.stringify(body, {
          ...previous.metadata.frontmatter,
          icon: sourceIcon,
        }),
        f.executable,
      );
    });
  if (asset) files.push(asset);
  return publish(p, id, files, expectedRevision, "Update skill icon");
}

export async function setIntegrations(
  p: Principal,
  id: string,
  integrations: string[],
  expectedRevision: string,
) {
  if (!permits(p, "update"))
    throw new Problem(403, "Update permission required");
  const r = await revisionFor(p, id, expectedRevision);
  const files = asSkillFiles(await withContent(r.files)).map((f) =>
    f.path !== "SKILL.md"
      ? f
      : makeFile(
          f.path,
          matter.stringify(
            matter(Buffer.from(f.content, "base64").toString("utf8")).content,
            { ...r.metadata.frontmatter, executorIntegrations: integrations },
          ),
          f.executable,
        ),
  );
  return publish(
    p,
    id,
    files,
    expectedRevision,
    "Update Executor integrations",
  );
}

export async function resolveReferenceId(value: string) {
  const uuid =
    referenceId(value) ??
    (REFERENCE_ID.test(value) ? value.toLowerCase() : null);
  if (!uuid) return value;
  const [row] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(eq(skills.referenceId, uuid));
  if (!row) throw new Problem(404, "Referenced skill is unavailable");
  return row.id;
}
export async function resolveSkillReference(p: Principal, uuid: string) {
  if (!REFERENCE_ID.test(uuid))
    throw new Problem(400, "Invalid skill reference ID");
  const id = await resolveReferenceId(uuid);
  if (!(await canRead(p, id)))
    throw new Problem(404, "Referenced skill is unavailable");
  const [row] = await db.select().from(skills).where(eq(skills.id, id));
  if (!row) throw new Problem(404, "Referenced skill is unavailable");
  return {
    referenceId: row.referenceId,
    id: row.id,
    title: row.title,
    revision: row.revision,
    disabled: row.disabled,
    archived: row.archived,
    icon: row.icon,
  };
}
async function referenceDetails(p: Principal, text: string) {
  const ids = extractSkillReferences(text);
  if (!ids.length) return {};
  const rows = await db
    .select({
      referenceId: skills.referenceId,
      id: skills.id,
      title: skills.title,
      revision: skills.revision,
      disabled: skills.disabled,
      archived: skills.archived,
    })
    .from(skills)
    .where(
      and(
        inList(skills.referenceId, ids),
        await grantFilter(p),
        p.role === "admin" ? sql`true` : eq(skills.disabled, false),
      ),
    );
  const found = new Map(rows.map((r) => [r.referenceId, r]));
  const references = ids.map((referenceId) => {
    const row = found.get(referenceId);
    return row
      ? { ...row, available: !row.disabled }
      : { referenceId, available: false };
  });
  return {
    skillReferences: references,
    referenceInstructions:
      "Markdown skill://UUID links reference other skills by immutable ID. When you reach a referenced workflow needed for the task, call load_skill with that UUID. Only load relevant targets; track visited IDs to avoid cycles and repeated loads. Unavailable targets may be disabled, missing or outside your permissions; do not bypass that restriction. References do not grant access or automatically execute anything.",
  };
}

export async function archiveSkill(
  p: Principal,
  id: string,
  expectedRevision: string,
) {
  if (!permits(p, "delete"))
    throw new Problem(403, "Delete permission required");
  const r = await revisionFor(p, id);
  const files = asSkillFiles(await withContent(r.files)).map((f) => {
    if (f.path !== "SKILL.md") return f;
    const parsed = matter(Buffer.from(f.content, "base64").toString("utf8"));
    return makeFile(
      f.path,
      matter.stringify(parsed.content, { ...parsed.data, archived: true }),
      f.executable,
    );
  });
  return publish(p, id, files, expectedRevision, "Archive skill", undefined, {
    archive: true,
  });
}
