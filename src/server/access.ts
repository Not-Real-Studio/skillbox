import { randomUUID } from "node:crypto";
import { and, eq, desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { profiles, clients, proposals, nameKey } from "./schema";
import { asSkillFiles, storeFiles, withContent } from "./files";
import { assertAdmin, createClient } from "./auth";
import * as lib from "./library";
import type { Principal, SkillFile } from "../shared";

export const profileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  allSkills: z.boolean(),
  skillIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/)).max(1000),
  permissions: z.object({
    create: z.boolean(),
    update: z.boolean(),
    delete: z.boolean(),
    propose: z.boolean(),
  }),
});
export async function saveProfile(
  p: Principal,
  input: z.infer<typeof profileSchema>,
  id: string = randomUUID(),
  version?: string,
) {
  assertAdmin(p);
  const body = profileSchema.parse(input);
  body.skillIds = [...new Set(body.skillIds)];
  // The unique name_key index replaces the advisory lock; the version check
  // is part of the UPDATE itself.
  try {
    if (version) {
      const rows = await db
        .update(profiles)
        .set({ ...body, nameKey: nameKey(body.name), version: randomUUID() })
        .where(and(eq(profiles.id, id), eq(profiles.version, version)))
        .returning();
      if (!rows.length)
        throw new lib.Problem(409, "Profile changed. Reload before saving.");
      return rows[0];
    }
    return (
      await db
        .insert(profiles)
        .values({ id, ...body, nameKey: nameKey(body.name) })
        .returning()
    )[0];
  } catch (e) {
    if (uniqueViolation(e, "profiles.name_key"))
      throw new lib.Problem(409, "A profile with this name already exists");
    throw e;
  }
}
export async function uniqueClient(name: string, profileId: string) {
  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.id, profileId));
  if (!profile) throw new lib.Problem(404, "Profile not found");
  try {
    return await createClient(name.trim(), "reader", false, [], profileId);
  } catch (e) {
    if (uniqueViolation(e, "clients.name_key"))
      throw new lib.Problem(
        409,
        "An active client already has this name. Use its existing key or give this connection a distinct name.",
      );
    throw e;
  }
}
/** D1 reports constraint failures only through the error message. */
export const uniqueViolation = (e: unknown, column: string) =>
  e instanceof Error &&
  /UNIQUE constraint failed/.test(String(e.message) + String(e.cause ?? "")) &&
  (String(e.message) + String(e.cause ?? "")).includes(column);
export async function propose(
  p: Principal,
  id: string,
  files: SkillFile[],
  expectedRevision: string,
  message: string,
) {
  if (!lib.permits(p, "propose"))
    throw new lib.Problem(403, "Proposal permission required");
  const current = await lib.revisionFor(p, id);
  if (current.id !== expectedRevision)
    throw new lib.Problem(409, "Skill changed. Reload before proposing.");
  lib.validateFiles(files);
  const metadata = lib.metadata(id, files);
  for (const key of [
    "kind",
    "members",
    "disabled",
    "archived",
    "replacement",
  ] as const)
    if (JSON.stringify(metadata[key]) !== JSON.stringify(current.metadata[key]))
      throw new lib.Problem(
        403,
        "Proposals can change skill content, not access or lifecycle settings",
      );
  const stored = await storeFiles(files);
  const [row] = await db
    .insert(proposals)
    .values({
      id: randomUUID(),
      skillId: id,
      clientId: p.id,
      clientName: p.name,
      files: stored,
      expectedRevision,
      message,
    })
    .returning({ id: proposals.id, status: proposals.status });
  await lib.record(p, "propose", id, { revision: expectedRevision });
  return row;
}
export async function listProposals(p: Principal) {
  return db
    .select({
      id: proposals.id,
      skillId: proposals.skillId,
      clientId: proposals.clientId,
      clientName: proposals.clientName,
      message: proposals.message,
      status: proposals.status,
      createdAt: proposals.createdAt,
      reviewedAt: proposals.reviewedAt,
      publishedRevision: proposals.publishedRevision,
    })
    .from(proposals)
    .where(p.role === "admin" ? undefined : eq(proposals.clientId, p.id))
    .orderBy(desc(proposals.createdAt))
    .limit(200);
}
export async function proposalDetail(p: Principal, id: string) {
  const [proposal] = await db
    .select()
    .from(proposals)
    .where(eq(proposals.id, id));
  if (!proposal || (p.role !== "admin" && proposal.clientId !== p.id))
    throw new lib.Problem(404, "Proposal not found");
  const base = await lib.revisionFor(
    p,
    proposal.skillId,
    proposal.expectedRevision,
  );
  return {
    ...proposal,
    files: asSkillFiles(await withContent(proposal.files)),
    baseFiles: asSkillFiles(await withContent(base.files)),
  };
}
export async function reviewProposal(
  p: Principal,
  id: string,
  decision: "approve" | "reject",
) {
  assertAdmin(p);
  const [proposal] = await db
    .select()
    .from(proposals)
    .where(eq(proposals.id, id));
  if (!proposal) throw new lib.Problem(404, "Proposal not found");
  if (proposal.status !== "pending")
    throw new lib.Problem(409, "Proposal already reviewed");
  const reviewedAt = new Date().toISOString();
  if (decision === "reject") {
    // Conditional on still pending: a concurrent review wins once.
    const rows = await db
      .update(proposals)
      .set({ status: "rejected", reviewer: p.name, reviewedAt })
      .where(and(eq(proposals.id, id), eq(proposals.status, "pending")))
      .returning({ id: proposals.id });
    if (!rows.length) throw new lib.Problem(409, "Proposal already reviewed");
    return { ok: true, revision: undefined };
  }
  // Approval publishes and marks the proposal in one batch, guarded by the
  // proposal still being pending (replaces SELECT … FOR UPDATE).
  const pending = {
    condition:
      "EXISTS (SELECT 1 FROM proposals WHERE id=? AND status='pending')",
    params: [id],
  };
  const result = await lib.publish(
    { ...p, name: `${p.name} (proposal by ${proposal.clientName})` },
    proposal.skillId,
    asSkillFiles(await withContent(proposal.files)),
    proposal.expectedRevision,
    proposal.message,
    undefined,
    {
      guard: { ...pending, conflict: "Proposal already reviewed" },
      also: [
        {
          sql: "UPDATE proposals SET status='approved',reviewer=?,reviewed_at=?,published_revision=(SELECT revision FROM skills WHERE id=?) WHERE id=? AND status='pending'",
          params: [p.name, reviewedAt, proposal.skillId, id],
        },
      ],
    },
  );
  return { ok: true, revision: result.revision };
}
