/**
 * In-memory pipeline runner for YAML-based integration tests.
 *
 * Builds EngineOpts directly from RuntimeEnv (no config loader, no Actual API)
 * and calls the real runSyncEngine + SyncEngine implementations.
 *
 * Settling algorithm:
 *   - Let N = steps.length
 *   - Run the full pipeline N+1 times (propagation budget).
 *   - Run once more and assert no changes were produced (idempotency check).
 */
import { runSyncEngine } from "../../../src/diff/sync-engine";
import { createMirrorEngine } from "../../../src/engines/mirror-engine";
import { createSplitEngine } from "../../../src/engines/split-engine";
import type { EngineOpts } from "../../../src/diff/sync-engine";
import type { MirrorStep, SplitStep } from "../../../src/config/schema";
import type { RuntimeEnv, RuntimeBudget } from "./runtime";
import { makeMockManager } from "./mock-budget-manager";
import { resetChangeCount, mockState } from "./actual-mock-state";

// ─── EngineOpts builders ──────────────────────────────────────────────────────

/** Large lookback so all test transactions fall within the window. */
const LOOKBACK_DAYS = 36500;

function resolveAccountId(
  budget: RuntimeBudget,
  accountRef: string
): string {
  // Check by name first, then by ID directly
  const byName = budget.accountsByName.get(accountRef);
  if (byName) return byName.id;
  if (budget.accounts.has(accountRef)) return accountRef;
  throw new Error(
    `Account "${accountRef}" not found in budget "${budget.alias}". ` +
      `Known accounts: ${[...budget.accountsByName.keys()].join(", ")}`
  );
}

function buildMirrorOptsInMemory(
  step: MirrorStep,
  env: RuntimeEnv
): EngineOpts {
  const srcBudget = env.budgets.get(step.source.budget);
  if (!srcBudget)
    throw new Error(`Mirror source budget "${step.source.budget}" not found`);

  const dstBudget = env.budgets.get(step.destination.budget);
  if (!dstBudget)
    throw new Error(`Mirror destination budget "${step.destination.budget}" not found`);

  const destAccountId = resolveAccountId(dstBudget, step.destination.account);

  const allBudgetIds = Array.from(env.budgets.values()).map((b) => b.id);
  const needsCrossBudgetIndex =
    allBudgetIds.length >= 3 &&
    step.source.budget !== step.destination.budget;

  return {
    sourceBudgetAlias: step.source.budget,
    sourceBudgetId: srcBudget.id,
    sourceAccountsSpec: step.source.accounts,
    requiredTags: step.source.requiredTags,
    destBudgetAlias: step.destination.budget,
    destBudgetId: dstBudget.id,
    destAccountIds: [destAccountId],
    lookbackDays: LOOKBACK_DAYS,
    dryRun: false,
    stepType: "mirror",
    deleteEnabled: step.delete,
    indexBudgetIds: needsCrossBudgetIndex ? allBudgetIds : undefined,
  };
}

function buildSplitOptsInMemory(
  step: SplitStep,
  env: RuntimeEnv
): EngineOpts {
  const budget = env.budgets.get(step.budget);
  if (!budget)
    throw new Error(`Split budget "${step.budget}" not found`);

  const tagEntries: Array<[string, { multiplier: number; destination_account: string }]> = [];
  const destAccountIds: string[] = [];

  for (const [tag, action] of Object.entries(step.tags)) {
    const destId = resolveAccountId(budget, action.destination_account);
    tagEntries.push([tag, { ...action, destination_account: destId }]);
    if (!destAccountIds.includes(destId)) destAccountIds.push(destId);
  }

  const isBroadSpec =
    step.source.accounts === "all" ||
    step.source.accounts === "on-budget" ||
    step.source.accounts === "off-budget";
  const excludeAccountIds = isBroadSpec ? new Set(destAccountIds) : undefined;

  return {
    sourceBudgetAlias: step.budget,
    sourceBudgetId: budget.id,
    sourceAccountsSpec: step.source.accounts,
    requiredTags: step.source.requiredTags,
    destBudgetAlias: step.budget,
    destBudgetId: budget.id,
    destAccountIds,
    lookbackDays: LOOKBACK_DAYS,
    dryRun: false,
    stepType: "split",
    tagEntries,
    excludeAccountIds,
  };
}

// ─── Pipeline step types (subset of config schema used in pipeline.yaml) ──────

export type InMemoryStep =
  | MirrorStep
  | SplitStep;

// ─── Single-round execution ───────────────────────────────────────────────────

/**
 * Execute every step in the pipeline once.
 * Returns true if any step produced at least one add/update/delete.
 */
export async function runOneRoundInMemory(
  env: RuntimeEnv,
  steps: InMemoryStep[]
): Promise<boolean> {
  const manager = makeMockManager(env);
  resetChangeCount();

  for (const step of steps) {
    if (step.type === "mirror") {
      const engine = createMirrorEngine(step);
      const opts = buildMirrorOptsInMemory(step, env);
      await runSyncEngine(engine, opts, manager);
    } else if (step.type === "split") {
      const engine = createSplitEngine(step);
      const opts = buildSplitOptsInMemory(step, env);
      await runSyncEngine(engine, opts, manager);
    }
  }

  return mockState.changeCount > 0;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export type PipelineResult = {
  /** true if the idempotency round produced no changes (pipeline converged) */
  converged: boolean;
  /** Number of settling rounds actually run (always N+1) */
  settlingRounds: number;
};

/**
 * Run the pipeline with the settling algorithm and return convergence info.
 *
 * Mutates `env` in place. The caller should call exportRuntimeToFixture
 * afterwards to compare with after.yaml.
 */
export async function runInMemoryPipeline(
  env: RuntimeEnv,
  steps: InMemoryStep[]
): Promise<PipelineResult> {
  const N = steps.length;
  const settlingRounds = N + 1;

  // Settling rounds — propagate changes fully
  for (let i = 0; i < settlingRounds; i++) {
    await runOneRoundInMemory(env, steps);
  }

  // Idempotency check round
  const changed = await runOneRoundInMemory(env, steps);

  return { converged: !changed, settlingRounds };
}
