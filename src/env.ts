/**
 * Environment variable handling for secrets. Loads and validates required env vars
 * before any download. BudgetManager receives these via injection instead of
 * reading process.env directly.
 */
import type { Config } from "./config/schema";

export type Secrets = {
  serverPassword: string;
  budgetKeys: Record<string, string>;
};

/**
 * Returns the env var name for a budget's encryption key.
 * e.g. "shared" → "AB_MIRROR_KEY_SHARED", "nick-personal" → "AB_MIRROR_KEY_NICK_PERSONAL"
 */
export function envKeyForBudget(alias: string): string {
  const key = alias.toUpperCase().replace(/-/g, "_");
  return `AB_MIRROR_KEY_${key}`;
}

/**
 * Loads secrets from config (after substitution) and env. Config values take
 * precedence when present. Validates that all encrypted budgets have keys set.
 * Throws before any download if validation fails.
 */
export function loadSecrets(config: Config): Secrets {
  const serverPassword =
    config.server.password ?? process.env["AB_MIRROR_SERVER_PASSWORD"] ?? "";

  const budgetKeys: Record<string, string> = {};

  for (const [alias, budgetConfig] of Object.entries(config.budgets)) {
    if (!budgetConfig.encrypted) continue;

    const value =
      budgetConfig.key ?? process.env[envKeyForBudget(alias)];
    if (value === undefined || value === "") {
      const envVar = envKeyForBudget(alias);
      throw new Error(
        `Budget "${alias}" is encrypted but has no key in config and ${envVar} is not set. Set key in config (e.g. key: "\${${envVar}}") or set the env var.`
      );
    }
    budgetKeys[alias] = value;
  }

  return { serverPassword, budgetKeys };
}
