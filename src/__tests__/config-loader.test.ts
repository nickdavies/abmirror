import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/loader";

/**
 * Verifies that tag order in the config file is preserved through loadConfig.
 * When a transaction has multiple action tags (e.g. #50/50 and #0/100), the
 * first tag in the config determines the outcome. Changing the order in the
 * YAML file changes which action applies.
 */
describe("loadConfig tag order preservation", () => {
  it("preserves tag order from YAML file (#0/100 before #50/50)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-mirror-config-test-"));
    const configPath = join(dir, "config.yaml");

    const yaml = `
server:
  url: http://localhost:5006
dataDir: /tmp
budgets:
  alpha: { syncId: sync-1, encrypted: false }
pipeline:
  - type: split
    budget: alpha
    source: { accounts: all }
    tags:
      "#0/100":
        multiplier: -1.0
        destination_account: dest
      "#50/50":
        multiplier: -0.5
        destination_account: dest
`;

    writeFileSync(configPath, yaml.trim(), "utf-8");
    const config = loadConfig(configPath);

    const step = config.pipeline[0];
    if (step?.type !== "split") throw new Error("Expected split step");

    const tagKeys = Object.keys(step.tags);
    expect(tagKeys).toEqual(["#0/100", "#50/50"]);
  });

  it("preserves tag order from YAML file (#50/50 before #0/100)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-mirror-config-test-"));
    const configPath = join(dir, "config.yaml");

    const yaml = `
server:
  url: http://localhost:5006
dataDir: /tmp
budgets:
  alpha: { syncId: sync-1, encrypted: false }
pipeline:
  - type: split
    budget: alpha
    source: { accounts: all }
    tags:
      "#50/50":
        multiplier: -0.5
        destination_account: dest
      "#0/100":
        multiplier: -1.0
        destination_account: dest
`;

    writeFileSync(configPath, yaml.trim(), "utf-8");
    const config = loadConfig(configPath);

    const step = config.pipeline[0];
    if (step?.type !== "split") throw new Error("Expected split step");

    const tagKeys = Object.keys(step.tags);
    expect(tagKeys).toEqual(["#50/50", "#0/100"]);
  });
});
