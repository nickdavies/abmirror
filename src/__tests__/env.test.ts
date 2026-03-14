import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { envKeyForBudget, loadSecrets } from "../env";
import type { Config } from "../config/schema";

describe("envKeyForBudget", () => {
  it("uppercases alias and replaces hyphens with underscores", () => {
    expect(envKeyForBudget("shared")).toBe("AB_MIRROR_KEY_SHARED");
    expect(envKeyForBudget("nick-personal")).toBe("AB_MIRROR_KEY_NICK_PERSONAL");
    expect(envKeyForBudget("my-budget")).toBe("AB_MIRROR_KEY_MY_BUDGET");
  });
});

describe("loadSecrets", () => {
  const baseConfig: Config = {
    server: { url: "http://localhost:5006" },
    dataDir: "/tmp/ab-mirror",
    budgets: {
      shared: { syncId: "sync-1", encrypted: false },
      "nick-personal": { syncId: "sync-2", encrypted: true },
    },
    pipeline: [],
    lookbackDays: 60,
  };

  const AB_MIRROR_SERVER_PASSWORD = "AB_MIRROR_SERVER_PASSWORD";
  const AB_MIRROR_KEY_NICK_PERSONAL = "AB_MIRROR_KEY_NICK_PERSONAL";

  beforeEach(() => {
    delete process.env[AB_MIRROR_SERVER_PASSWORD];
    delete process.env[AB_MIRROR_KEY_NICK_PERSONAL];
  });

  afterEach(() => {
    delete process.env[AB_MIRROR_SERVER_PASSWORD];
    delete process.env[AB_MIRROR_KEY_NICK_PERSONAL];
  });

  it("returns serverPassword from env, empty string if unset", () => {
    process.env[AB_MIRROR_KEY_NICK_PERSONAL] = "key123";
    const secrets = loadSecrets(baseConfig);
    expect(secrets.serverPassword).toBe("");
    expect(secrets.budgetKeys).toEqual({ "nick-personal": "key123" });
  });

  it("returns serverPassword when set", () => {
    process.env[AB_MIRROR_SERVER_PASSWORD] = "server-secret";
    process.env[AB_MIRROR_KEY_NICK_PERSONAL] = "key123";
    const secrets = loadSecrets(baseConfig);
    expect(secrets.serverPassword).toBe("server-secret");
  });

  it("includes budget keys only for encrypted budgets", () => {
    process.env[AB_MIRROR_KEY_NICK_PERSONAL] = "key123";
    const secrets = loadSecrets(baseConfig);
    expect(secrets.budgetKeys).toEqual({ "nick-personal": "key123" });
    expect(secrets.budgetKeys["shared"]).toBeUndefined();
  });

  it("throws when encrypted budget has no key set", () => {
    expect(() => loadSecrets(baseConfig)).toThrow(
      'Budget "nick-personal" is encrypted but AB_MIRROR_KEY_NICK_PERSONAL is not set'
    );
  });

  it("throws when encrypted budget has empty key", () => {
    process.env[AB_MIRROR_KEY_NICK_PERSONAL] = "";
    expect(() => loadSecrets(baseConfig)).toThrow(
      'Budget "nick-personal" is encrypted but AB_MIRROR_KEY_NICK_PERSONAL is not set'
    );
  });

  it("succeeds when no budgets are encrypted", () => {
    const config: Config = {
      ...baseConfig,
      budgets: {
        shared: { syncId: "sync-1", encrypted: false },
      },
    };
    const secrets = loadSecrets(config);
    expect(secrets.budgetKeys).toEqual({});
  });
});
