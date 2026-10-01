import {
  sqliteTable,
  text,
  integer,
  index,
} from "drizzle-orm/sqlite-core";
import type { SkillMetadata, GitHubSource, StoredFile } from "../shared";
// D1/SQLite: JSON lives in text columns, timestamps are ISO-8601 strings
// (lexicographic order = time order), UUID defaults come from the code.
// DDL is in migrations/*.sql; this file must stay in step with it.
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
const flag = (name: string) => integer(name, { mode: "boolean" });
export const skills = sqliteTable("skills", {
  referenceId: text("reference_id").notNull().unique().$defaultFn(uuid),
  packageMetrics:
    json<ReturnType<typeof import("../package-metrics").packageMetrics>>(
      "package_metrics",
    ),
  icon: json<import("../skill-icons").SkillIcon | null>("icon"),
  id: text("id").primaryKey(),
  kind: text("kind").$type<"skill" | "bundle">().notNull().default("skill"),
  members: json<string[]>("members").notNull().default([]),
  archived: flag("archived").notNull().default(false),
  disabled: flag("disabled").notNull().default(false),
  replacement: text("replacement"),
  title: text("title").notNull(),
  description: text("description").notNull(),
  tags: json<string[]>("tags").notNull().default([]),
  revision: text("revision").notNull(),
  searchText: text("search_text").notNull(),
  updatedAt: text("updated_at").notNull().$defaultFn(now),
});
export const revisions = sqliteTable(
  "revisions",
  {
    id: text("id").primaryKey(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id),
    metadata: json<SkillMetadata>("metadata").notNull(),
    // Manifest only; file bytes are R2 objects files/<sha256> (see files.ts).
    files: json<StoredFile[]>("files").notNull(),
    source: json<GitHubSource>("source"),
    checksum: text("checksum").notNull(),
    message: text("message").notNull(),
    author: text("author").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("revisions_skill_idx").on(t.skillId)],
);
export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // lower(trim(name)) computed in code: SQLite lower() is ASCII-only.
  nameKey: text("name_key").notNull().unique(),
  allSkills: flag("all_skills").notNull().default(false),
  skillIds: json<string[]>("skill_ids").notNull().default([]),
  permissions: json<import("../shared").Permissions>("permissions").notNull(),
  version: text("version").notNull().$defaultFn(uuid),
});
export const proposals = sqliteTable("proposals", {
  id: text("id").primaryKey(),
  skillId: text("skill_id").notNull(),
  clientId: text("client_id").notNull(),
  clientName: text("client_name").notNull(),
  expectedRevision: text("expected_revision").notNull(),
  files: json<StoredFile[]>("files").notNull(),
  message: text("message").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull().$defaultFn(now),
  reviewedAt: text("reviewed_at"),
  reviewer: text("reviewer"),
  publishedRevision: text("published_revision"),
});
export const clients = sqliteTable("clients", {
  profileId: text("profile_id")
    .notNull()
    .references(() => profiles.id),
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // Unique among active clients (partial index in the migration).
  nameKey: text("name_key").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  role: text("role").notNull().default("reader"),
  allSkills: flag("all_skills").notNull().default(false),
  skillIds: json<string[]>("skill_ids").notNull().default([]),
  active: flag("active").notNull().default(true),
  createdAt: text("created_at").notNull().$defaultFn(now),
});
export const sessions = sqliteTable("sessions", {
  hash: text("hash").primaryKey(),
  expiresAt: text("expires_at").notNull(),
});
export const events = sqliteTable("events", {
  context: json<import("../shared").AccessContext>("context")
    .notNull()
    .default({}),
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull(),
  clientName: text("client_name").notNull(),
  operation: text("operation").notNull(),
  skillId: text("skill_id"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});
export const workspaceSettings = sqliteTable("workspace_settings", {
  id: text("id").primaryKey(),
  value: text("value").notNull(),
});
/** Case-insensitive uniqueness key for profile and client names. */
export const nameKey = (name: string) => name.trim().toLowerCase();
