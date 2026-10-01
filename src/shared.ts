import type { SkillIcon } from "./skill-icons";
export type JevProvider = "vercel" | "typesafe" | "openrouter";
export type GitHubSource = {
  type: "github";
  repository: string;
  commit: string;
  path: string;
  url: string;
};
export type GitHubImportPreview =
  | { kind: "catalog"; url: string; commit: string; candidates: string[] }
  | {
      kind: "skill";
      id: string;
      source: GitHubSource;
      instructions: string;
      files: Omit<SkillFile, "content">[];
      skipped: string[];
      warnings: {
        code: string;
        path: string;
        message: string;
        severity: string;
      }[];
      expectedRevision: string | null;
    };
export type SkillFile = {
  path: string;
  content: string;
  sha256: string;
  size: number;
  executable: boolean;
};
/** Revision manifest entry; the bytes live in R2 under files/<sha256>. */
export type StoredFile = Omit<SkillFile, "content"> & { mime: string };
export type SkillMetadata = {
  executorIntegrations?: string[];
  icon?: SkillIcon | null;
  kind: "skill" | "bundle";
  members: string[];
  archived: boolean;
  disabled: boolean;
  replacement: string | null;
  name: string;
  title: string;
  description: string;
  tags: string[];
  requirements: Record<string, unknown>;
  frontmatter: Record<string, unknown>;
};
export type AccessContext = {
  source?: string;
  harness?: string;
  model?: string;
  task?: string;
  purpose?: string;
  revision?: string;
  path?: string;
  outcome?: string;
};
export type Permissions = {
  create: boolean;
  update: boolean;
  delete: boolean;
  propose: boolean;
};
export type Principal = {
  profileId?: string;
  permissions?: Permissions;
  context?: AccessContext;
  id: string;
  name: string;
  role: "admin" | "writer" | "reader";
  allSkills: boolean;
  skillIds: string[];
};
export type SkillSummary = {
  referenceId?: string;
  characters?: number;
  fileCount?: number;
  packageBytes?: number;
  entryCharacters?: number;
  lastUsedAt?: string | null;
  lastAgentReadAt?: string | null;
  lastAgentReadBy?: string | null;
  readCount?: number;
  usageCount?: number;
  lastAccessedAt?: string | null;
  lastAccessedBy?: string | null;
  icon?: SkillIcon | null;
  kind: "skill" | "bundle";
  members: string[];
  archived: boolean;
  disabled: boolean;
  replacement: string | null;
  id: string;
  title: string;
  description: string;
  tags: string[];
  revision: string;
  updatedAt: string;
};
