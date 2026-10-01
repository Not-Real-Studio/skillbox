import { createHash } from "node:crypto";
import { platform } from "./db";
import { Problem } from "./library";
import { mimeTypeForPath } from "../skill-manifest";
import type { SkillFile, StoredFile } from "../shared";

// Revision and proposal files are content-addressed R2 objects: files/<sha256>.
// Identical bytes are stored once across revisions and skills. Objects are
// written before the D1 row that references them and never deleted, so a
// failed publish can leave unreferenced objects but never a dangling manifest.
const key = (sha256: string) => `files/${sha256}`;
// Workers allow 6 simultaneous outgoing connections per request.
const PARALLEL = 6;

async function each<T>(items: T[], fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

export const manifest = (files: SkillFile[]): StoredFile[] =>
  files.map(({ content, ...file }) => ({
    ...file,
    mime: mimeTypeForPath(file.path),
  }));

/** Uploads validated files (see validateFiles) and returns their manifest. */
export async function storeFiles(files: SkillFile[]) {
  const bucket = platform().files;
  const unique = [...new Map(files.map((f) => [f.sha256, f])).values()];
  await each(unique, async (file) => {
    if (await bucket.head(key(file.sha256))) return;
    // R2 verifies the SHA-256 on upload.
    await bucket.put(key(file.sha256), Buffer.from(file.content, "base64"), {
      sha256: file.sha256,
      httpMetadata: { contentType: mimeTypeForPath(file.path) },
    });
  });
  return manifest(files);
}

/**
 * Loads file bytes from R2 as base64 content. With `paths`, only those files
 * get content; the rest keep manifest fields only (their bytes were verified
 * when written).
 */
export async function withContent<T extends Omit<SkillFile, "content">>(
  files: T[],
  paths?: Iterable<string>,
): Promise<(T & { content: string })[]>;
export async function withContent<T extends Omit<SkillFile, "content">>(
  files: T[],
  paths: Iterable<string>,
  partial: true,
): Promise<(T & { content?: string })[]>;
export async function withContent<T extends Omit<SkillFile, "content">>(
  files: T[],
  paths?: Iterable<string>,
) {
  const wanted = paths ? new Set(paths) : null;
  const shas = [
    ...new Set(
      files.filter((f) => !wanted || wanted.has(f.path)).map((f) => f.sha256),
    ),
  ];
  const content = new Map<string, string>();
  const bucket = platform().files;
  await each(shas, async (sha256) => {
    const object = await bucket.get(key(sha256));
    if (!object) throw new Problem(500, "Stored file is missing");
    const bytes = Buffer.from(await object.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== sha256)
      throw new Problem(500, "Stored file failed its integrity check");
    content.set(sha256, bytes.toString("base64"));
  });
  return files.map((f) => {
    const value = content.get(f.sha256);
    return value === undefined ? { ...f } : { ...f, content: value };
  });
}

/** Strips manifest-only fields so files compare and serialize like SkillFile. */
export const asSkillFiles = (files: (StoredFile & { content: string })[]) =>
  files.map(
    ({ mime, ...file }): SkillFile => ({
      path: file.path,
      content: file.content,
      sha256: file.sha256,
      size: file.size,
      executable: file.executable,
    }),
  );
