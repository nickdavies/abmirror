import { readFileSync } from "fs";
import { parse } from "yaml";
import { ZodError } from "zod";
import { ConfigSchema, type Config } from "./schema";

/**
 * Replaces ${VAR} placeholders with process.env[VAR]. Strict: throws if any
 * referenced variable is unset or empty.
 */
function substituteEnvVars(text: string): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, varName) => {
    const value = process.env[varName];
    if (value === undefined || value === "") {
      throw new Error(
        `Config references ${varName} but it is not set or empty. Set this environment variable before running.`
      );
    }
    return value;
  });
}

export function loadConfig(configPath: string): Config {
  let raw: unknown;
  try {
    const text = readFileSync(configPath, "utf-8");
    const substituted = substituteEnvVars(text);
    raw = parse(substituted);
  } catch (err) {
    throw new Error(`Failed to read config file "${configPath}": ${String(err)}`);
  }

  try {
    const config = ConfigSchema.parse(raw);
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
