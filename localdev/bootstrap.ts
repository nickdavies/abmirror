#!/usr/bin/env npx tsx
/**
 * Bootstrap localdev: import Actual budget zips into a running Actual server,
 * then write localdev/config.yaml with sync IDs for ab-mirror.
 *
 * Usage: ./bootstrap.sh [--port 5007] nick.zip britta.zip joint.zip
 *
 * Encrypted exports are uploaded unencrypted (export contains decrypted data).
 * No keys needed for bootstrap.
 */
import * as actual from "@actual-app/api";
import { existsSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { stringify } from "yaml";

const DEFAULT_PORT = 5007;
const SERVER_PASSWORD = "test";

function parseArgs(): { port: number; zips: string[] } {
  const args = process.argv.slice(2);
  let port = DEFAULT_PORT;
  const zips: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (!args[i].startsWith("-")) {
      zips.push(args[i]);
    }
  }

  // Resolve relative paths to absolute (relative to dir user ran script from)
  const cwd = process.env.INVOKE_CWD ?? process.cwd();
  const resolvedZips = zips.map((z) => (z.startsWith("/") ? z : resolve(cwd, z)));
  return { port, zips: resolvedZips };
}

function aliasFromZipPath(zipPath: string): string {
  const basename = zipPath.split("/").pop() ?? zipPath;
  const withoutExt = basename.replace(/\.(zip|blob)$/i, "");
  return withoutExt || "budget";
}

async function main(): Promise<void> {
  const { port, zips } = parseArgs();
  if (zips.length === 0) {
    console.error("Usage: bootstrap.sh [--port 5007] <zip1> [zip2] [zip3] ...");
    process.exit(1);
  }

  const serverUrl = `http://localhost:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), "ab-mirror-bootstrap-"));

  // API's sqlite backup writes to ACTUAL_DATA_DIR; ensure it exists
  process.env.ACTUAL_DATA_DIR = dataDir;

  console.log(`Connecting to ${serverUrl}...`);
  await actual.init({
    dataDir,
    serverURL: serverUrl,
    password: SERVER_PASSWORD,
  });

  const { internal } = actual as typeof actual & {
    internal: { send: (name: string, args?: unknown) => Promise<unknown> };
  };

  const aliasToInfo: Array<{ alias: string; budgetId: string }> = [];

  for (const zipPath of zips) {
    if (!existsSync(zipPath)) {
      throw new Error(`File not found: ${zipPath}`);
    }
    const alias = aliasFromZipPath(zipPath);
    console.log(`Importing ${zipPath} as "${alias}"...`);

    const result = (await internal.send("import-budget", {
      filepath: zipPath,
      type: "actual",
    })) as { error?: string } | undefined;

    if (result?.error) {
      throw new Error(`Import failed for ${zipPath}: ${result.error}`);
    }

    const prefs = (await internal.send("load-prefs")) as {
      id?: string;
      encryptKeyId?: string;
    } | undefined;
    const budgetId = prefs?.id;

    if (!budgetId) {
      throw new Error(`Import succeeded but could not get budget id for ${zipPath}`);
    }

    // Encrypted exports contain decrypted data; strip encryption and upload unencrypted.
    // Import leaves cloudFileId from OLD server, so use a new one for this server.
    if (prefs?.encryptKeyId) {
      await internal.send("save-prefs", {
        cloudFileId: crypto.randomUUID(),
        encryptKeyId: null,
      });
    }
    const uploadResult = (await internal.send("upload-budget")) as { error?: { reason?: string } } | undefined;
    if (uploadResult?.error) {
      throw new Error(`Upload failed for "${alias}": ${uploadResult.error.reason ?? "unknown"}`);
    }

    aliasToInfo.push({ alias, budgetId });
  }

  const budgets = await actual.getBudgets();
  await actual.shutdown();

  const localdevDir = import.meta.dirname ?? __dirname;

  const budgetEntries: Record<string, { syncId: string; encrypted: boolean }> = {};

  for (const { alias, budgetId } of aliasToInfo) {
    const budget = budgets.find((b) => b.id === budgetId);
    if (!budget) {
      throw new Error(
        `Could not find budget ${budgetId} for "${alias}". Budgets: ${budgets.map((b) => b.id).join(", ")}`
      );
    }
    const syncId = (budget as { groupId?: string }).groupId;
    if (!syncId) {
      throw new Error(
        `Budget "${alias}" has no sync ID (groupId). It may not have uploaded.`
      );
    }
    budgetEntries[alias] = { syncId, encrypted: false };
  }

  const configPath = join(localdevDir, "config.yaml");
  const config = {
    server: { url: serverUrl, password: SERVER_PASSWORD },
    dataDir: join(localdevDir, ".ab-mirror-cache"),
    budgets: budgetEntries,
    lookbackDays: 60,
    pipeline: [] as unknown[],
  };

  writeFileSync(configPath, stringify(config), "utf-8");
  console.log(`\nConfig written to ${configPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
