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
import type { GlobalTxIndex, RootTxIndex } from "../../../src/diff/global-tx-index";
import { isABMirrorId, parseImportedId } from "../../../src/util/imported-id";
import type { MirrorStep, SplitStep } from "../../../src/config/schema";
import type { RuntimeEnv, RuntimeBudget } from "./runtime";
import { makeMockManager } from "./mock-budget-manager";
import { resetChangeCount, mockState } from "./actual-mock-state";

// ─── EngineOpts builders ──────────────────────────────────────────────────────

/** Wide date window so all test transactions fall within scope. */
const START_DATE = "1900-01-01";
const END_DATE = "2099-12-31";

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

/**
 * Scan the in-memory RuntimeEnv and build a GlobalTxIndex equivalent to
 * what buildGlobalTxIndex does against real Actual budgets.
 */
function buildGlobalTxIndexInMemory(env: RuntimeEnv): GlobalTxIndex {
  const index: GlobalTxIndex = new Map();
  for (const budget of env.budgets.values()) {
    for (const account of budget.accounts.values()) {
      for (const tx of account.transactions.values()) {
        if (tx.tombstone) continue;
        if (!isABMirrorId(tx.imported_id)) continue;
        const parsed = parseImportedId(tx.imported_id as string);
        if (!parsed) continue;
        const key = `${parsed.budgetId}:${parsed.txId}`;
        if (!index.has(key)) index.set(key, new Set());
        index.get(key)!.add(`${budget.id}:${account.id}`);
      }
    }
  }
  return index;
}

function buildRootTxIndexInMemory(env: RuntimeEnv): RootTxIndex {
  const index: RootTxIndex = new Map();
  for (const budget of env.budgets.values()) {
    for (const account of budget.accounts.values()) {
      for (const tx of account.transactions.values()) {
        if (tx.tombstone) continue;
        if (!isABMirrorId(tx.imported_id)) {
          if (!index.has(budget.id)) index.set(budget.id, new Set());
          index.get(budget.id)!.add(tx.id);
        }
        // Sub-transactions are stored embedded on the parent (not as separate map entries).
        // The real API returns children as separate items from getTransactions, so their IDs
        // naturally land in rootTxIndex. Mirror the same behaviour here.
        if (tx.subtransactions) {
          for (const sub of tx.subtransactions) {
            if (!isABMirrorId(sub.imported_id)) {
              if (!index.has(budget.id)) index.set(budget.id, new Set());
              index.get(budget.id)!.add(sub.id);
            }
          }
        }
      }
    }
  }
  return index;
}

function buildMirrorOptsInMemory(
  step: MirrorStep,
  env: RuntimeEnv,
  globalTxIndex: GlobalTxIndex,
  rootTxIndex: RootTxIndex
): EngineOpts {
  const srcBudget = env.budgets.get(step.source.budget);
  if (!srcBudget)
    throw new Error(`Mirror source budget "${step.source.budget}" not found`);

  const dstBudget = env.budgets.get(step.destination.budget);
  if (!dstBudget)
    throw new Error(`Mirror destination budget "${step.destination.budget}" not found`);

  const destAccountId = resolveAccountId(dstBudget, step.destination.account);

  return {
    sourceBudgetAlias: step.source.budget,
    sourceBudgetId: srcBudget.id,
    sourceAccountsSpec: step.source.accounts,
    requiredTags: step.source.requiredTags,
    destBudgetAlias: step.destination.budget,
    destBudgetId: dstBudget.id,
    destAccountIds: [destAccountId],
    startDate: START_DATE,
    endDate: END_DATE,
    dryRun: false,
    stepType: "mirror",
    deleteEnabled: step.delete ?? false,
    updateFields: step.updateFields ?? false,
    globalTxIndex,
    rootTxIndex,
  };
}

function buildSplitOptsInMemory(
  step: SplitStep,
  env: RuntimeEnv,
  rootTxIndex: RootTxIndex
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

  let defaultAction: import("../../../src/diff/sync-engine").EngineOpts["defaultAction"];
  if (step.default) {
    const destId = resolveAccountId(budget, step.default.destination_account);
    defaultAction = { ...step.default, destination_account: destId };
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
    startDate: START_DATE,
    endDate: END_DATE,
    dryRun: false,
    stepType: "split",
    deleteEnabled: step.delete ?? false,
    updateFields: step.updateFields ?? false,
    tagEntries,
    excludeAccountIds,
    defaultAction,
    rootTxIndex,
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

  // Pre-pass: build both indexes for loop prevention and root-existence delete semantics.
  const globalTxIndex = buildGlobalTxIndexInMemory(env);
  const rootTxIndex = buildRootTxIndexInMemory(env);

  const debugSync = process.env.DEBUG_SYNC === "1";

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex]!;
    if (step.type === "mirror") {
      const engine = createMirrorEngine(step);
      const opts = { ...buildMirrorOptsInMemory(step, env, globalTxIndex, rootTxIndex), stepIndex, ...(debugSync && { debugSync: true }) };
      await runSyncEngine(engine, opts, manager);
    } else if (step.type === "split") {
      const engine = createSplitEngine(step);
      const opts = { ...buildSplitOptsInMemory(step, env, rootTxIndex), stepIndex, ...(debugSync && { debugSync: true }) };
      await runSyncEngine(engine, opts, manager);
    }
  }

  return mockState.changeCount > 0;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export type PipelineResult = {
  /** true if the idempotency round produced no changes (pipeline converged) */
  converged: boolean;
  /** Number of settling rounds run (N+1 propagation + 1 idempotency check) */
  settlingRounds: number;
};

/**
 * Run the pipeline with the settling algorithm and return convergence info.
 *
 * Logic: run N+1 full pipeline rounds (so changes can propagate across all steps),
 * then run one more round and require no changes (idempotency). If that final
 * round produces any change, the pipeline did not converge.
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

  for (let i = 0; i < settlingRounds; i++) {
    await runOneRoundInMemory(env, steps);
  }

  const changed = await runOneRoundInMemory(env, steps);

  return { converged: !changed, settlingRounds };
}
