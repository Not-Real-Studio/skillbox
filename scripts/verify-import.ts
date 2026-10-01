// Compares a source skillbox instance with the target an import wrote to:
// entries, flags, reference IDs, icons, full history and every revision's files.
// Uses the same SKILLBOX_SOURCE_* / SKILLBOX_TARGET_* variables as the importer.
export {};
const side = (prefix: string) => {
  const base = process.env[`SKILLBOX_${prefix}_URL`]!.replace(/\/$/, "");
  const token = process.env[`SKILLBOX_${prefix}_TOKEN`]!;
  return async (path: string) => {
    const r = await fetch(base + path, {
      headers: { Authorization: "Bearer " + token },
    });
    if (!r.ok) throw new Error(`${prefix} ${path}: ${r.status}`);
    return r.json();
  };
};
const source = side("SOURCE"),
  target = side("TARGET");
const ms = (v: string) =>
  Math.floor(Date.parse(v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")));
const list =
  "/api/skills?kind=all&includeArchived=true&includeDisabled=true&limit=500";
const pick = (s: any) => ({
  id: s.id,
  referenceId: s.referenceId,
  kind: s.kind,
  archived: s.archived,
  disabled: s.disabled,
  revision: s.revision,
  title: s.title,
  description: s.description,
  tags: s.tags,
  members: s.members,
  replacement: s.replacement,
  icon: s.icon,
});
let problems = 0;
// Key order is not data: Postgres jsonb sorts keys, D1 keeps insertion order.
// updatedAt is the row write time; the import sets it to the revision time
// (the source's differs by milliseconds), so it is not compared.
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .filter((k) => k !== "updatedAt")
            .sort()
            .map((k) => [k, canonical((v as any)[k])]),
        )
      : v;
const same = (what: string, a: unknown, b: unknown) => {
  if (JSON.stringify(canonical(a)) !== JSON.stringify(canonical(b))) {
    problems++;
    console.log(
      `DIFF ${what}\n  source: ${JSON.stringify(a).slice(0, 300)}\n  target: ${JSON.stringify(b).slice(0, 300)}`,
    );
  }
};
const a = (await source(list)).items.map(pick),
  b = (await target(list)).items.map(pick);
same("entries", a, b);
let revisions = 0,
  files = 0;
for (const s of a) {
  const ha = await source(`/api/skills/${s.id}/history`),
    hb = await target(`/api/skills/${s.id}/history`);
  const norm = (h: any[]) =>
    h
      .map((r) => ({ ...r, createdAt: ms(r.createdAt) }))
      .sort((x, y) => x.createdAt - y.createdAt);
  same(`${s.id} history`, norm(ha), norm(hb));
  for (const r of ha) {
    const fa = await source(
        `/api/skills/${s.id}/bundle?revision=${r.revision}`,
      ),
      fb = await target(`/api/skills/${s.id}/bundle?revision=${r.revision}`);
    same(`${s.id}@${r.revision} bundle`, fa, fb);
    revisions++;
    files += fa.files.length;
  }
  same(
    `${s.id} load`,
    { ...(await source(`/api/skills/${s.id}`)), portability: 0 },
    { ...(await target(`/api/skills/${s.id}`)), portability: 0 },
  );
}
console.log(
  problems
    ? `${problems} difference(s)`
    : `Identical: ${a.length} entries, ${revisions} revisions, ${files} files`,
);
process.exit(problems ? 1 : 0);
