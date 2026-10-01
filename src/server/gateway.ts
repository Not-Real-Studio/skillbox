import { randomUUID } from "node:crypto";
import { z } from "zod";
import { d1 } from "./db";
import { seal, open } from "./secret-storage";
import {
  createRecommender,
  evaluateJev,
  EvaluationUnavailable,
} from "./recommendations";
import type { JevProvider } from "../shared";
import { Problem } from "./library";

const providerSchema = z.enum(["vercel", "typesafe", "openrouter"], {
  error: "Choose Vercel AI Gateway, TypeSafe AI or OpenRouter",
});
const configSchema = z
  .object({
    revision: z.string(),
    provider: providerSchema.default("vercel"),
    // Old encrypted Gateway-only settings migrate on read without losing the key.
    apiKey: z.string().nullable().optional(),
    keys: z
      .object({
        vercel: z.string().nullable(),
        typesafe: z.string().nullable(),
        openrouter: z.string().nullable().default(null),
      })
      .optional(),
  })
  .transform((config) => ({
    revision: config.revision,
    provider: config.provider,
    keys: config.keys ?? {
      vercel: config.apiKey ?? null,
      typesafe: null,
      openrouter: null,
    },
  }));
type Config = z.output<typeof configSchema>;
export const gatewayInput = z
  .object({
    provider: providerSchema.optional(),
    apiKey: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .regex(/^\S+$/, "API key must not contain whitespace")
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (value) => value.provider !== undefined || value.apiKey !== undefined,
    "Choose a provider or update its key",
  );
function decode(value?: unknown): Config {
  return value
    ? configSchema.parse(open(value as Parameters<typeof open>[0]))
    : {
        revision: "unconfigured",
        provider: "vercel",
        keys: { vercel: null, typesafe: null, openrouter: null },
      };
}
async function readRow() {
  const row = await d1
    .prepare("SELECT value FROM workspace_settings WHERE id='ai_gateway'")
    .first<{ value: string }>();
  return row?.value ?? null;
}
async function readConfig() {
  const value = await readRow();
  return decode(value ? JSON.parse(value) : undefined);
}
function status(config: Config) {
  return {
    provider: config.provider,
    configured: !!config.keys[config.provider],
    providers: {
      vercel: { configured: !!config.keys.vercel },
      typesafe: { configured: !!config.keys.typesafe },
      openrouter: { configured: !!config.keys.openrouter },
    },
    revision: config.revision,
  };
}
export async function gatewaySettings() {
  return status(await readConfig());
}
let engine:
  | {
      revision: string;
      provider: JevProvider;
      rank: ReturnType<typeof createRecommender>;
    }
  | undefined;
export async function configureGateway(input: z.input<typeof gatewayInput>) {
  const update = gatewayInput.parse(input);
  // Two owner tabs updating different providers must not overwrite each
  // other's keys: compare-and-swap on the stored value, retried on conflict
  // (D1 has no advisory locks).
  let result: ReturnType<typeof status> | undefined;
  for (let attempt = 0; !result; attempt++) {
    if (attempt === 5)
      throw new Problem(409, "Settings changed concurrently. Try again.");
    const previous = await readRow();
    const config = decode(previous ? JSON.parse(previous) : undefined);
    // Legacy callers of /settings/ai-gateway omit provider; their keys remain Gateway-only.
    config.provider = update.provider ?? "vercel";
    if (update.apiKey !== undefined)
      config.keys[config.provider] = update.apiKey;
    config.revision = randomUUID();
    const value = JSON.stringify(seal(config));
    const write = previous
      ? d1
          .prepare(
            "UPDATE workspace_settings SET value=? WHERE id='ai_gateway' AND value=?",
          )
          .bind(value, previous)
      : d1
          .prepare(
            "INSERT INTO workspace_settings(id,value) VALUES ('ai_gateway',?) ON CONFLICT(id) DO NOTHING",
          )
          .bind(value);
    if ((await write.run()).meta.changes) result = status(config);
  }
  engine = undefined;
  return result;
}
export async function gatewayRecommender() {
  const config = await readConfig();
  if (engine?.revision !== config.revision) {
    const apiKey = config.keys[config.provider];
    engine = {
      revision: config.revision,
      provider: config.provider,
      rank: createRecommender(
        apiKey
          ? async (task, candidates, signal) => {
              if ((await readConfig()).revision !== config.revision)
                throw new EvaluationUnavailable("configuration_changed");
              return evaluateJev(
                task,
                candidates,
                signal,
                apiKey,
                config.provider,
              );
            }
          : undefined,
      ),
    };
  }
  return engine;
}
