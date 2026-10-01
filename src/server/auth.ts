import { timingSafeEqual, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db } from "./db";
import { clients, sessions, profiles, nameKey } from "./schema";
import { ADMIN, Problem, sha256 } from "./library";
import type { Principal } from "../shared";
export const token = () => randomBytes(32).toString("base64url");
export function isAdminToken(value: string) {
  const configured = process.env.SKILLBOX_ADMIN_TOKEN;
  if (!configured || configured.length < 32) return false;
  return timingSafeEqual(
    Buffer.from(sha256(value)),
    Buffer.from(sha256(configured)),
  );
}
export async function authenticate(
  req: Request,
  allowSession = false,
): Promise<Principal> {
  const bearer = req.headers
    .get("authorization")
    ?.match(/^Bearer (.{1,512})$/i)?.[1];
  if (bearer) {
    if (isAdminToken(bearer)) return { ...ADMIN, context: requestContext(req) };
    const [row] = await db
      .select()
      .from(clients)
      .innerJoin(profiles, eq(clients.profileId, profiles.id))
      .where(
        and(eq(clients.tokenHash, sha256(bearer)), eq(clients.active, true)),
      );
    if (row) {
      const c = row.clients,
        profile = row.profiles;
      return {
        context: requestContext(req),
        id: c.id,
        name: c.name,
        role:
          profile.permissions.create || profile.permissions.update
            ? "writer"
            : "reader",
        profileId: profile.id,
        permissions: profile.permissions,
        allSkills: profile.allSkills,
        skillIds: profile.skillIds,
      };
    }
  }
  if (allowSession) {
    const cookie = req.headers
      .get("cookie")
      ?.match(/(?:^|;\s*)skillbox_session=([^;]+)/)?.[1];
    if (cookie) {
      const [s] = await db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.hash, sha256(cookie)),
            gt(sessions.expiresAt, new Date().toISOString()),
          ),
        );
      if (s)
        return { ...ADMIN, context: { source: "web", harness: "Skillbox UI" } };
    }
  }
  throw new Problem(401, "Authentication required");
}
export async function createClient(
  name: string,
  role: "reader" | "writer",
  allSkills: boolean,
  skillIds: string[],
  profileId?: string,
) {
  const secret = token(),
    id = randomUUID();
  const client = db.insert(clients).values({
    id,
    name,
    nameKey: nameKey(name),
    profileId: profileId ?? id,
    role,
    allSkills,
    skillIds,
    tokenHash: sha256(secret),
  });
  if (profileId) await client;
  // A legacy-style client gets its own profile; both rows land atomically.
  else
    await db.batch([
      db.insert(profiles).values({
        id,
        name,
        nameKey: nameKey(name) + ":" + id,
        allSkills,
        skillIds,
        permissions: {
          create: role === "writer",
          update: role === "writer",
          delete: false,
          propose: false,
        },
      }),
      client,
    ]);
  return { id, token: secret };
}
export function assertAdmin(p: Principal) {
  if (p.role !== "admin")
    throw new Problem(403, "Administrator access required");
}

function requestContext(req: Request) {
  const field = (name: string) => req.headers.get(name)?.slice(0, 160);
  return {
    source:
      new URL(req.url).pathname === "/mcp"
        ? "mcp"
        : req.headers.get("x-skillbox-source") === "cli"
          ? "cli"
          : "api",
    harness: field("x-skillbox-harness"),
    model: field("x-skillbox-model"),
  };
}
