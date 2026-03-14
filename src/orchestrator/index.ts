/**
 * Pipeline orchestrator: runs preflight validation then executes steps in order.
 * Budget syncing happens automatically on every budget switch (via
 * BudgetManager.open) and at the end of the pipeline.
 */
import type { Config } from "../config/schema";
import { BudgetManager } from "../client/budget-manager";
import { runSyncer } from "../syncer/index";
import { runSplitter } from "../splitter/index";
import { runPreflight } from "./preflight";

export interface RunOptions {
  config: Config;
  dryRun?: boolean;
  /** If provided, only run the pipeline step at this 0-based index. */
  stepIndex?: number;
  /** Show verbose infrastructure messages from Actual API. */
  verbose?: boolean;
}

export async function runPipeline(opts: RunOptions): Promise<void> {
  const { config, dryRun = false, stepIndex, verbose = false } = opts;

  const manager = new BudgetManager(config);
  await manager.init({ verbose });

  try {
    // Preflight downloads all budgets and validates everything
    console.log("Running preflight validation...");
    const result = await runPreflight(config, manager);
    if (!result.ok) {
      console.error("Preflight validation failed:");
      for (const err of result.errors) {
        console.error(`  - ${err}`);
      }
      process.exit(1);
    }
    console.log("Preflight OK.");

    const steps =
      stepIndex !== undefined
        ? config.pipeline.slice(stepIndex, stepIndex + 1)
        : config.pipeline;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const displayIndex = stepIndex ?? i;
      console.log(`\nStep ${displayIndex + 1}: ${step.type}`);

      if (step.type === "split") {
        const budgetInfo = manager.getInfo(step.budget);
        await runSplitter(
          {
            step,
            budgetId: budgetInfo.budgetId,
            lookbackDays: config.lookbackDays,
            dryRun,
          },
          manager
        );
        continue;
      }

      if (step.type === "mirror") {
        const sourceBudgetInfo = manager.getInfo(step.source.budget);
        await runSyncer(
          {
            step,
            sourceBudgetId: sourceBudgetInfo.budgetId,
            lookbackDays: config.lookbackDays,
            dryRun,
          },
          manager
        );
        continue;
      }
    }

    // Implicit final sync after all steps
    console.log("\nFinal sync...");
    await manager.syncAll();
  } finally {
    await manager.shutdown();
  }
}

/** Validate-only: same as runPipeline but stops after preflight. */
export async function validateConfig(
  config: Config,
  opts?: { verbose?: boolean }
): Promise<void> {
  const manager = new BudgetManager(config);
  await manager.init({ verbose: opts?.verbose ?? false });

  try {
    const result = await runPreflight(config, manager);
    if (!result.ok) {
      console.error("Validation failed:");
      for (const err of result.errors) {
        console.error(`  - ${err}`);
      }
      process.exit(1);
    }
    console.log("Validation passed.");
  } finally {
    await manager.shutdown();
  }
}
