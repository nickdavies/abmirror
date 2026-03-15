/**
 * Pipeline orchestrator: runs preflight validation then executes steps in order.
 * Budget syncing happens automatically on every budget switch (via
 * BudgetManager.open) and at the end of the pipeline.
 */
import type { Config } from "../config/schema";
import type { Secrets } from "../env";
import { BudgetManager } from "../client/budget-manager";
import { createRunReporter } from "../notify/reporter";
import { runSyncEngine } from "../diff/sync-engine";
import { createMirrorEngine, buildMirrorOpts } from "../engines/mirror-engine";
import { createSplitEngine, buildSplitOpts } from "../engines/split-engine";
import { runPreflight } from "./preflight";

export interface RunOptions {
  config: Config;
  secrets: Secrets;
  dryRun?: boolean;
  /** If provided, only run the pipeline step at this 0-based index. */
  stepIndex?: number;
  /** Show verbose infrastructure messages from Actual API. */
  verbose?: boolean;
  /** Log each sync/download with a counter (for debugging). */
  debugSync?: boolean;
}

export async function runPipeline(opts: RunOptions): Promise<void> {
  const { config, secrets, dryRun = false, stepIndex, verbose = false, debugSync = false } = opts;

  const manager = new BudgetManager(config, secrets, { debugSync });
  await manager.init({ verbose });

  const startTime = Date.now();
  const reporter = createRunReporter(config, { startTime });
  let success = true;

  try {
    // Preflight downloads all budgets and validates everything
    console.log("Running preflight validation...");
    const result = await runPreflight(config, manager, reporter);
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
        const engine = createSplitEngine(step);
        const opts = await buildSplitOpts(
          step,
          {
            lookbackDays: config.lookbackDays,
            dryRun,
            reporter,
            stepIndex: displayIndex,
          },
          manager
        );
        await runSyncEngine(engine, opts, manager);
        continue;
      }

      if (step.type === "mirror") {
        const engine = createMirrorEngine(step);
        const opts = await buildMirrorOpts(
          step,
          {
            lookbackDays: config.lookbackDays,
            dryRun,
            reporter,
          },
          manager
        );
        await runSyncEngine(engine, opts, manager);
        continue;
      }
    }

    // Implicit final sync after all steps
    console.log("\nFinal sync...");
    await manager.syncAll();

    const counts = manager.getDebugCounts();
    if (debugSync) {
      console.error(`[debug] pipeline complete: ${counts.sync} syncs, ${counts.download} downloads`);
    }
  } catch (err) {
    success = false;
    throw err;
  } finally {
    reporter.send(success);
    await manager.shutdown();
  }
}

/** Validate-only: same as runPipeline but stops after preflight. */
export async function validateConfig(
  config: Config,
  opts: { secrets: Secrets; verbose?: boolean; debugSync?: boolean }
): Promise<void> {
  const { secrets, verbose = false, debugSync = false } = opts;
  const manager = new BudgetManager(config, secrets, { debugSync });
  await manager.init({ verbose });

  const reporter = createRunReporter(config);

  try {
    const result = await runPreflight(config, manager, reporter);
    if (!result.ok) {
      console.error("Validation failed:");
      for (const err of result.errors) {
        console.error(`  - ${err}`);
      }
      if (debugSync) {
        const counts = manager.getDebugCounts();
        console.error(`[debug] validate preflight: ${counts.sync} syncs, ${counts.download} downloads`);
      }
      process.exit(1);
    }
    console.log("Validation passed.");
    reporter.send(true);
  } finally {
    await manager.shutdown();
  }
}
