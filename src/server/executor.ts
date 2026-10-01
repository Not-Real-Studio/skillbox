import { randomBytes } from "node:crypto";
import { seal, open } from "./secret-storage";
import { appOrigin, executorResourceAliases } from "./config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { d1 } from "./db";
import { Problem } from "./library";
type Config = {
  endpoint: string;
  bearer?: string;
  client?: any;
  tokens?: any;
  verifier?: string;
  state?: string;
  stateAt?: number;
  expiresAt?: number;
};
async function read(): Promise<Config> {
  const row = await d1
    .prepare("SELECT value FROM workspace_settings WHERE id='executor'")
    .first<{ value: string }>();
  return row ? (open(JSON.parse(row.value)) as Config) : { endpoint: "" };
}
async function save(c: Config) {
  await d1
    .prepare(
      "INSERT INTO workspace_settings(id,value) VALUES ('executor',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
    )
    .bind(JSON.stringify(seal(c)))
    .run();
}
let queue = Promise.resolve();
function serial<T>(f: () => Promise<T>): Promise<T> {
  const result = queue.then(f);
  queue = result.then(
    () => {},
    () => {},
  );
  return result;
}
let cache: any = null;
export async function executorSettings() {
  const c = await read();
  return {
    endpoint: c.endpoint,
    authenticated: !!(c.tokens || c.bearer),
    authMethod: c.bearer ? "token" : c.tokens ? "oauth" : "none",
  };
}
export function configureExecutor(endpoint: string, bearer?: string) {
  return serial(async () => {
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Problem(
        400,
        "Use an HTTPS MCP endpoint without credentials or query parameters",
      );
    let c = await read();
    if (c.endpoint !== url.href) c = { endpoint: url.href };
    if (bearer !== undefined) {
      c.bearer = bearer || undefined;
      c.tokens = undefined;
    }
    await save(c);
    cache = null;
    return executorSettings();
  });
}
export async function validateExecutorResource(
  serverUrl: string | URL,
  resource?: string,
): Promise<URL> {
  if (!resource) return new URL(serverUrl);
  const server = new URL(serverUrl),
    advertised = new URL(resource);
  if (
    advertised.username ||
    advertised.password ||
    advertised.search ||
    advertised.hash
  )
    throw new Error("Invalid OAuth resource");
  const compatibility = executorResourceAliases()[server.href] === advertised.href;
  if (
    !compatibility &&
    (server.origin !== advertised.origin ||
      !(
        server.pathname === advertised.pathname ||
        server.pathname.startsWith(advertised.pathname.replace(/\/$/, "") + "/")
      ))
  )
    throw new Error("Executor OAuth resource does not match endpoint");
  return advertised;
}
function provider(
  c: Config,
  onRedirect: (url: string) => void,
): OAuthClientProvider {
  return {
    validateResourceURL: validateExecutorResource,
    redirectUrl: appOrigin() + "/api/executor/callback",
    clientMetadata: {
      client_name: "Skillbox",
      scope: "openid profile email offline_access",
      redirect_uris: [appOrigin() + "/api/executor/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    state: () => c.state!,
    clientInformation: () => c.client,
    saveClientInformation: async (v) => {
      c.client = v;
      await save(c);
    },
    tokens: () => c.tokens,
    saveTokens: async (t) => {
      c.tokens = t;
      c.expiresAt = t.expires_in ? Date.now() + t.expires_in * 1000 : undefined;
      await save(c);
    },
    saveCodeVerifier: async (v) => {
      c.verifier = v;
      await save(c);
    },
    codeVerifier: () => {
      if (!c.verifier) throw new Error("No pending authorization");
      return c.verifier;
    },
    redirectToAuthorization: async (url) => onRedirect(url.href),
    invalidateCredentials: async (scope) => {
      if (scope === "all" || scope === "tokens") c.tokens = undefined;
      if (scope === "all" || scope === "client") c.client = undefined;
      await save(c);
    },
  };
}
const timedFetch = (input: string | URL | Request, init?: RequestInit) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(20000) });
export function authorizeExecutor(code?: string, state?: string) {
  return serial(async () => {
    const c = await read();
    if (!c.endpoint) throw new Problem(400, "Set an Executor endpoint in Settings first");
    if (code) {
      if (
        !state ||
        state !== c.state ||
        !c.stateAt ||
        Date.now() - c.stateAt > 600000
      )
        throw new Problem(400, "Authorization expired; connect again");
    } else {
      c.state = randomBytes(32).toString("hex");
      c.stateAt = Date.now();
      c.bearer = undefined;
      await save(c);
    }
    let url: string | undefined;
    try {
      const result = await auth(
        provider(c, (u) => (url = u)),
        { serverUrl: c.endpoint, authorizationCode: code, fetchFn: timedFetch },
      );
      if (result === "AUTHORIZED") {
        c.state = undefined;
        c.stateAt = undefined;
        c.verifier = undefined;
        await save(c);
        cache = null;
        return { connected: true };
      }
      return { url };
    } catch {
      throw new Problem(
        502,
        "Executor authorization failed. Check the endpoint and try connecting again.",
      );
    }
  });
}
export function disconnectExecutor() {
  return serial(async () => {
    const c = await read();
    await save({ endpoint: c.endpoint });
    cache = null;
    return { ok: true };
  });
}
export function executorCatalog(refresh = false) {
  return serial(async () => {
    if (cache && !refresh && Date.now() - cache.checkedAt < 60000) return cache;
    const c = await read();
    if (!c.tokens && !c.bearer)
      throw new Problem(401, "Connect Executor in Settings first");
    const client = new Client({ name: "skillbox", version: "0.1.0" });
    let redirect = false;
    const oauth = provider(c, () => {
      redirect = true;
    });
    try {
      if (c.expiresAt && Date.now() > c.expiresAt - 30000 && c.tokens) {
        await auth(oauth, { serverUrl: c.endpoint, fetchFn: timedFetch });
        if (redirect) throw new Error("Reconnect");
      }
      const transport = new StreamableHTTPClientTransport(new URL(c.endpoint), {
        authProvider: c.bearer ? undefined : oauth,
        requestInit: c.bearer
          ? { headers: { Authorization: "Bearer " + c.bearer } }
          : undefined,
        fetch: timedFetch,
      });
      await client.connect(transport);
      const result = await client.callTool(
        {
          name: "execute",
          arguments: {
            code: "const r=await tools.executor.coreTools.connections.list({}); if(!r.ok) return {error:r.error.code}; return r.data.connections.map(c=>({integration:c.integration,status:c.lastHealth?.status,checkedAt:c.lastHealth?.checkedAt}));",
          },
        },
        undefined,
        { timeout: 25000 },
      );
      if (result.isError) throw new Error("Inventory failed");
      const blocks = result.content as { type: string; text?: string }[];
      let parsed: any = JSON.parse(
        blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join(""),
      );
      if (parsed.result !== undefined)
        parsed =
          typeof parsed.result === "string"
            ? JSON.parse(parsed.result)
            : parsed.result;
      if (!Array.isArray(parsed)) throw new Error("Unexpected inventory");
      const groups = new Map<string, any[]>();
      for (const item of parsed) {
        if (typeof item.integration !== "string") continue;
        groups.set(item.integration, [
          ...(groups.get(item.integration) ?? []),
          item,
        ]);
      }
      cache = {
        checkedAt: Date.now(),
        items: [...groups]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, connections]) => ({
            id,
            status: connections.some((c) => c.status === "healthy")
              ? "healthy"
              : connections.some((c) => c.status === "degraded")
                ? "degraded"
                : connections.some((c) => c.status === "unhealthy")
                  ? "unhealthy"
                  : "unknown",
            connections: connections.length,
            checkedAt: Math.max(...connections.map((c) => c.checkedAt ?? 0)),
          })),
      };
      return cache;
    } catch {
      throw new Problem(
        502,
        "Could not read Executor connections. Connect in Settings or check the endpoint.",
      );
    } finally {
      await client.close().catch(() => {});
    }
  });
}
