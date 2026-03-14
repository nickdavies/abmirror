#!/usr/bin/env node
/**
 * CLI entry point. Commands:
 *   ab-mirror validate --config <path>
 *   ab-mirror run --config <path> [--dry-run] [--step <n>]
 *   ab-mirror list-accounts --config <path> [--budget <alias>]
 *   ab-mirror list-budgets --server <url> [--data-dir <path>]
 */
import { tmpdir } from "os";
import { join } from "path";
import { Command } from "commander";
import { loadConfig } from "./config/loader";
import { runPipeline, validateConfig } from "./orchestrator/index";
import { runListAccounts } from "./commands/list-accounts";
import {
  resolvePassword,
  runListBudgets,
} from "./commands/list-budgets";
import { BudgetManager } from "./client/budget-manager";

const program = new Command();

program
  .name("ab-mirror")
  .description("Cross-budget transaction sync and split tool for Actual Budget")
  .version("0.1.0");

program
  .command("validate")
  .description(
    "Download all budgets from config and validate accounts, categories, and tags. No mutations."
  )
  .requiredOption("--config <path>", "Path to YAML config file")
  .action(async (opts: { config: string }) => {
    const config = loadConfig(opts.config);
    await validateConfig(config);
  });

program
  .command("list-accounts")
  .description(
    "List account names and IDs for each budget. Shows type (on/off-budget), status (open/closed), and balance to help pick the right ID when names are ambiguous."
  )
  .requiredOption("--config <path>", "Path to YAML config file")
  .option("--budget <alias>", "Only list accounts for this budget alias")
  .action(async (opts: { config: string; budget?: string }) => {
    const config = loadConfig(opts.config);
    const manager = new BudgetManager(config);
    await manager.init();
    try {
      await runListAccounts({
        config,
        manager,
        budgetAlias: opts.budget,
      });
    } finally {
      await manager.shutdown();
    }
  });

program
  .command("list-budgets")
  .description(
    "List sync IDs and budget names for a given Actual sync server. Prompts for password if required and not set in AB_MIRROR_SERVER_PASSWORD."
  )
  .requiredOption("--server <url>", "Actual sync server URL (e.g. http://localhost:5006)")
  .option(
    "--data-dir <path>",
    "Temporary directory for API init",
    join(tmpdir(), "ab-mirror-list-budgets")
  )
  .action(async (opts: { server: string; dataDir: string }) => {
    const password = await resolvePassword(opts.server);
    await runListBudgets({
      serverUrl: opts.server,
      dataDir: opts.dataDir,
      password,
    });
  });

program
  .command("run")
  .description(
    "Run the full pipeline (preflight validation runs first). Use --dry-run to simulate."
  )
  .requiredOption("--config <path>", "Path to YAML config file")
  .option("--dry-run", "Validate and simulate execution without writing anything")
  .option("--step <n>", "Run only the pipeline step at this 1-based index", parseInt)
  .action(async (opts: { config: string; dryRun?: boolean; step?: number }) => {
    const config = loadConfig(opts.config);

    // Convert 1-based CLI step to 0-based index
    let stepIndex: number | undefined;
    if (opts.step !== undefined) {
      if (isNaN(opts.step) || opts.step < 1 || opts.step > config.pipeline.length) {
        console.error(
          `--step must be between 1 and ${config.pipeline.length} (got ${opts.step})`
        );
        process.exit(1);
      }
      stepIndex = opts.step - 1;
    }

    await runPipeline({ config, dryRun: opts.dryRun ?? false, stepIndex });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
