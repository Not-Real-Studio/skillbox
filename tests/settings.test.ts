import { expect, test } from "bun:test";
import { open, seal } from "../src/server/secret-storage";
import {
  allowedOrigins,
  appOrigin,
  executorResourceAliases,
} from "../src/server/config";

test("neutral defaults and explicit origin aliases", () => {
  const keys = [
    "SKILLBOX_ORIGIN",
    "SKILLBOX_ALLOWED_ORIGINS",
    "SKILLBOX_EXECUTOR_RESOURCE_ALIASES",
  ] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) delete process.env[key];
  try {
    expect(appOrigin()).toBe("http://127.0.0.1:4791");
    expect([...allowedOrigins()]).toEqual(["http://127.0.0.1:4791"]);
    expect(executorResourceAliases()).toEqual({});
    process.env.SKILLBOX_ORIGIN = "https://skills.example.com";
    process.env.SKILLBOX_ALLOWED_ORIGINS = "https://legacy.example.com";
    expect([...allowedOrigins()]).toEqual([
      "https://skills.example.com",
      "https://legacy.example.com",
    ]);
    process.env.SKILLBOX_ALLOWED_ORIGINS = "https://user:password@example.com";
    expect(allowedOrigins).toThrow();
    process.env.SKILLBOX_EXECUTOR_RESOURCE_ALIASES =
      '{"https://mcp.example.com":"http://wrong.example.com"}';
    expect(executorResourceAliases).toThrow();
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
  }
});

test("stored secrets use authenticated encryption and fail closed after token changes", () => {
  const previous = process.env.SKILLBOX_ADMIN_TOKEN;
  process.env.SKILLBOX_ADMIN_TOKEN =
    "isolated-test-owner-token-at-least-32-chars";
  try {
    const encrypted = seal({ apiKey: "fixture-secret" });
    expect(JSON.stringify(encrypted)).not.toContain("fixture-secret");
    expect(open(encrypted)).toEqual({ apiKey: "fixture-secret" });
    expect(seal({ apiKey: "fixture-secret" })).not.toEqual(encrypted);
    expect(() =>
      open({ ...encrypted, tag: Buffer.alloc(16).toString("base64") }),
    ).toThrow();
    process.env.SKILLBOX_ADMIN_TOKEN =
      "different-test-owner-token-at-least-32-chars";
    expect(() => open(encrypted)).toThrow();
    delete process.env.SKILLBOX_ADMIN_TOKEN;
    expect(() => seal({ apiKey: "fixture-secret" })).toThrow();
  } finally {
    if (previous === undefined) delete process.env.SKILLBOX_ADMIN_TOKEN;
    else process.env.SKILLBOX_ADMIN_TOKEN = previous;
  }
});
