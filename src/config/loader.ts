import { readFileSync } from "fs";
import { parse } from "yaml";
import { ZodError } from "zod";
import { ConfigSchema, type Config } from "./schema";

export function loadConfig(configPath: string): Config {
  let raw: unknown;
  try {
    const text = readFileSync(configPath, "utf-8");
    raw = parse(text);
  } catch (err) {
    throw new Error(`Failed to read config file "${configPath}": ${String(err)}`);
  }

  try {
    return ConfigSchema.parse(raw);
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
