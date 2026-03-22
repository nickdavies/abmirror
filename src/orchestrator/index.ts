/**
 * Pipeline orchestrator: runs preflight validation then executes steps in order.
 * Budget syncing happens automatically on every budget switch (via
 * BudgetManager.open) and at the end of the pipeline.
 */
import type { Config } from "../config/schema";

export class PreflightError extends Error {
  public readonly errors: string[];
  constructor(errors: string[]) {
    super("Preflight validation failed:\n" + errors.map((e) => `  - ${e}`).join("\n"));
    this.name = "PreflightError";
    this.errors = errors;
  }
}
import type { Secrets } from "../env";
import { BudgetManager } from "../client/budget-manager";
import { createRunReporter } from "../notify/reporter";
import { runSyncEngine } from "../diff/sync-engine";
import { createMirrorEngine, buildMirrorOpts } from "../engines/mirror-engine";
import { createSplitEngine, buildSplitOpts } from "../engines/split-engine";
import { runPreflight } from "./preflight";
import { buildGlobalTxIndex } from "../diff/global-tx-index";

export interface RunOptions {
  config: Config;
  secrets: Secrets;
  dryRun?: boolean;
  /** If provided, only run the pipeline step at this 0-based index. */
  stepIndex?: number;
  /** Override config maxChangesPerStep. undefined = use config value. */
  maxChangesPerStep?: number;
  /** Show verbose infrastructure messages from Actual API. */
  verbose?: boolean;
  /** Log each sync/download with a counter (for debugging). */
  debugSync?: boolean;
}

export async function runPipeline(opts: RunOptions): Promise<void> {
  const { config, secrets, dryRun = false, stepIndex, verbose = false, debugSync = false } = opts;
  // CLI flag overrides config; 0 means unlimited (passed as 0, which is falsy → no-op in check)
  const maxChangesPerStep = opts.maxChangesPerStep ?? config.maxChangesPerStep;

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
      throw new PreflightError(result.errors);
    }
    console.log("Preflight OK.");

    const steps =
      stepIndex !== undefined
        ? config.pipeline.slice(stepIndex, stepIndex + 1)
        : config.pipeline;

    // Pre-pass: build both indexes for loop prevention and root-existence delete semantics.
    const { globalTxIndex, rootTxIndex } = await buildGlobalTxIndex(
      Object.keys(config.budgets),
      config.lookbackDays,
      manager
    );

    // Build destOwnerMap: for each dest account, which source budget UUIDs have
    // a mirror step writing to it. Used to avoid non-owner steps overwriting
    // fresh data placed by owner steps earlier in the pipeline.
    const destOwnerMap = new Map<string, Set<string>>();
    for (const rs of result.resolvedSteps) {
      if (rs.type === "mirror") {
        const srcBudgetId = manager.getInfo(rs.srcAlias).budgetId;
        if (!destOwnerMap.has(rs.dstAccountId)) destOwnerMap.set(rs.dstAccountId, new Set());
        destOwnerMap.get(rs.dstAccountId)!.add(srcBudgetId);
      }
    }

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
            rootTxIndex,
            maxChangesPerStep,
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
            globalTxIndex,
            rootTxIndex,
            maxChangesPerStep,
            destOwnerMap,
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
    await reporter.send(success);
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
      if (debugSync) {
        const counts = manager.getDebugCounts();
        console.error(`[debug] validate preflight: ${counts.sync} syncs, ${counts.download} downloads`);
      }
      throw new PreflightError(result.errors);
    }
    console.log("Validation passed.");
    await reporter.send(true);
  } finally {
    await manager.shutdown();
  }
}
