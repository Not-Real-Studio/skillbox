// Copies every skill and bundle with its full revision history from any skillbox
// instance (the upstream Bun/Postgres one or this Worker) into a skillbox Worker
// on D1 + R2, through the HTTP APIs of both. Revision IDs, reference IDs,
// authors, messages, times and GitHub provenance are preserved; file bytes are
// verified against their SHA-256 on both ends. Re-running resumes: revisions
// already present are skipped. Profiles, clients, proposals, events and
// provider settings are not copied — recreate clients on the new instance.
//
//   SKILLBOX_SOURCE_URL=https://old.example.com SKILLBOX_SOURCE_TOKEN=... \
//   SKILLBOX_TARGET_URL=https://new.example.com SKILLBOX_TARGET_TOKEN=... \
//   bun scripts/import-from-skillbox.ts
//
// Either side can be a directory instead: --save <dir> writes the source export
// as JSON files (and skips the target), --from <dir> imports such an export.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type File = {
  path: string;
  content: string;
  sha256: string;
  size: number;
  executable: boolean;
};
type Revision = {
  revision: string;
  message: string;
  author: string;
  createdAt: string;
  checksum: string;
  source?: unknown;
};
type ExportedSkill = {
  id: string;
  referenceId: string;
  revisions: (Revision & { files: File[] })[];
};

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const saveDir = arg("--save");
const fromDir = arg("--from");

function endpoint(prefix: string) {
  const url = process.env[`SKILLBOX_${prefix}_URL`];
  const token = process.env[`SKILLBOX_${prefix}_TOKEN`];
  if (!url || !token)
    throw new Error(`Set SKILLBOX_${prefix}_URL and SKILLBOX_${prefix}_TOKEN`);
  const base = url.replace(/\/$/, "");
  return async (path: string, init: RequestInit = {}) => {
    const r = await fetch(base + path, {
      ...init,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    const body = await r.json().catch(() => null);
    if (!r.ok)
      throw Object.assign(
        new Error(
          `${init.method ?? "GET"} ${path}: HTTP ${r.status} ${body?.error ?? ""}`,
        ),
        { status: r.status },
      );
    return body;
  };
}

// Postgres renders timestamptz as "2026-10-01 18:00:00.123456+00".
const iso = (value: string) =>
  new Date(
    value.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"),
  ).toISOString();
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function verify(skill: string, revision: string, files: File[]) {
  for (const f of files) {
    const bytes = Buffer.from(f.content, "base64");
    if (bytes.length !== f.size || sha256(bytes) !== f.sha256)
      throw new Error(`${skill}@${revision}: ${f.path} fails its digest`);
  }
}

async function* exportFromInstance(): AsyncGenerator<ExportedSkill> {
  const source = endpoint("SOURCE");
  const entries: { id: string; referenceId: string }[] = [];
  for (let offset: number | null = 0; offset !== null;) {
    const page = await source(
      `/api/skills?kind=all&includeArchived=true&includeDisabled=true&limit=500&offset=${offset}`,
    );
    entries.push(...page.items);
    offset = page.nextOffset;
  }
  for (const entry of entries) {
    const history: Revision[] = await source(
      `/api/skills/${encodeURIComponent(entry.id)}/history`,
    );
    const revisions = [];
    // Oldest first: each imported revision becomes current in turn.
    for (const r of [...history].sort((a, b) =>
      iso(a.createdAt) < iso(b.createdAt) ? -1 : 1,
    )) {
      const bundle = await source(
        `/api/skills/${encodeURIComponent(entry.id)}/bundle?revision=${encodeURIComponent(r.revision)}`,
      );
      verify(entry.id, r.revision, bundle.files);
      revisions.push({
        ...r,
        createdAt: iso(r.createdAt),
        files: bundle.files,
      });
    }
    yield { id: entry.id, referenceId: entry.referenceId, revisions };
  }
}

async function* exportFromDir(dir: string): AsyncGenerator<ExportedSkill> {
  const index: string[] = JSON.parse(
    await readFile(join(dir, "index.json"), "utf8"),
  );
  for (const id of index)
    yield JSON.parse(await readFile(join(dir, `${id}.json`), "utf8"));
}

const skills = fromDir ? exportFromDir(fromDir) : exportFromInstance();
const target = saveDir ? null : endpoint("TARGET");
if (saveDir) await mkdir(saveDir, { recursive: true, mode: 0o700 });
const saved: string[] = [];
let imported = 0,
  skipped = 0,
  entries = 0;
for await (const skill of skills) {
  entries++;
  if (saveDir) {
    await writeFile(join(saveDir, `${skill.id}.json`), JSON.stringify(skill), {
      mode: 0o600,
    });
    saved.push(skill.id);
    continue;
  }
  let previous: string | null = null;
  for (const r of skill.revisions) {
    verify(skill.id, r.revision, r.files);
    const result = await target!(
      `/api/import/skills/${encodeURIComponent(skill.id)}/revisions`,
      {
        method: "POST",
        body: JSON.stringify({
          referenceId: skill.referenceId,
          previous,
          revision: {
            id: r.revision,
            message: r.message,
            author: r.author,
            createdAt: r.createdAt,
            checksum: r.checksum,
            ...(r.source ? { source: r.source } : {}),
          },
          files: r.files,
        }),
      },
    );
    if (result.imported) imported++;
    else skipped++;
    previous = r.revision;
  }
  console.log(`${skill.id}: ${skill.revisions.length} revision(s)`);
}
if (saveDir) {
  await writeFile(join(saveDir, "index.json"), JSON.stringify(saved));
  console.log(`Saved ${entries} entries to ${saveDir}`);
} else
  console.log(
    `Imported ${entries} entries: ${imported} revision(s) written, ${skipped} already present`,
  );
