import { readFileSync } from "fs";
import { parse } from "yaml";
import { ZodError } from "zod";
import { ConfigSchema, type Config } from "./schema";

/** Resolve notify.pushover user/token from env when absent in config. */
function resolveNotifySecrets(config: Config): void {
  const pushover = config.notify?.pushover;
  if (!pushover) return;
  if (!pushover.user) {
    const v = process.env.AB_MIRROR_PUSHOVER_USER;
    if (v) (pushover as { user?: string }).user = v;
  }
  if (!pushover.token) {
    const v = process.env.AB_MIRROR_PUSHOVER_TOKEN;
    if (v) (pushover as { token?: string }).token = v;
  }
}

export function loadConfig(configPath: string): Config {
  let raw: unknown;
  try {
    const text = readFileSync(configPath, "utf-8");
    raw = parse(text);
  } catch (err) {
    throw new Error(`Failed to read config file "${configPath}": ${String(err)}`);
  }

  try {
    const config = ConfigSchema.parse(raw);
    resolveNotifySecrets(config);
    return config;
  } catch (err) {
    if (err instanceof ZodError) {
      const details = err.errors
        .map((e) => `  ${e.path.join(".")}: ${e.message}`)
        .join("\n");
      throw new Error(`Config validation failed:\n${details}`);
    }
    throw err;
  }
}
