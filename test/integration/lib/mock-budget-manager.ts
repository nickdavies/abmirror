/**
 * In-memory BudgetManager substitute for use with runSyncEngine in YAML tests.
 *
 * Only implements the two methods that runSyncEngine calls on the manager:
 *   manager.open(alias)    → updates mockState.openAlias, returns BudgetInfo
 *   manager.getInfo(alias) → returns BudgetInfo without switching
 *
 * Extends the real BudgetManager with dummy constructor args so TypeScript
 * accepts it wherever a BudgetManager is expected.
 */
import { BudgetManager } from "../../../src/client/budget-manager";
import type { BudgetInfo } from "../../../src/client/budget-manager";
import type { RuntimeEnv } from "./runtime";
import { mockState } from "./actual-mock-state";
import { runtimeBudgetId } from "./fixture";

export class MockBudgetManager extends BudgetManager {
  private readonly runtimeEnv: RuntimeEnv;

  constructor(env: RuntimeEnv) {
    // BudgetManager requires Config + Secrets but we never call any of its
    // network methods, so pass empty stubs.
    super(
      {
        server: { url: "http://localhost:0" },
        dataDir: "/dev/null",
        budgets: {},
        pipeline: [],
        lookbackDays: 9999,
      } as never,
      {} as never
    );
    this.runtimeEnv = env;
  }

  override async open(alias: string): Promise<BudgetInfo> {
    const budget = this.runtimeEnv.budgets.get(alias);
    if (!budget) throw new Error(`MockBudgetManager: unknown budget alias "${alias}"`);
    mockState.openAlias = alias;
    return { alias, budgetId: budget.id, syncId: budget.id };
  }

  override getInfo(alias: string): BudgetInfo {
    const budget = this.runtimeEnv.budgets.get(alias);
    if (!budget) throw new Error(`MockBudgetManager: unknown budget alias "${alias}"`);
    return { alias, budgetId: budget.id, syncId: budget.id };
  }

  /** All budget IDs from the runtime env (used by buildMirrorOpts for cross-budget indexing). */
  override getAllBudgetIds(): string[] {
    return Array.from(this.runtimeEnv.budgets.values()).map((b) => b.id);
  }

  override async syncAll(): Promise<void> {
    // no-op in tests
  }

  override async shutdown(): Promise<void> {
    // no-op in tests
  }
}

/** Convenience: create a MockBudgetManager already pointing at env. */
export function makeMockManager(env: RuntimeEnv): MockBudgetManager {
  mockState.env = env;
  return new MockBudgetManager(env);
}

/**
 * Helper used by pipeline-runner to look up a budget's runtime ID without
 * going through the manager.
 */
export function getBudgetInfo(env: RuntimeEnv, alias: string): BudgetInfo {
  const budget = env.budgets.get(alias);
  if (!budget) throw new Error(`getBudgetInfo: unknown alias "${alias}"`);
  return { alias, budgetId: runtimeBudgetId(alias), syncId: runtimeBudgetId(alias) };
}
