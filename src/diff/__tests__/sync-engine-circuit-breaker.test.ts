import { describe, it, expect, vi, beforeEach } from "vitest";
import { runSyncEngine } from "../sync-engine";
import type { EngineOpts, SyncEngine, ProposeResult } from "../sync-engine";
import type { NewTransaction } from "../../selector/types";
import { formatImportedId } from "../../util/imported-id";

// Mock @actual-app/api — runSyncEngine calls getAccounts, getTransactions,
// addTransactions, updateTransaction, deleteTransaction.
vi.mock("@actual-app/api", () => ({
  getAccounts: vi.fn().mockResolvedValue([
    { id: "src-acct", name: "Source", type: "checking" },
    { id: "dest-acct", name: "Dest", type: "checking" },
  ]),
  getTransactions: vi.fn().mockResolvedValue([]),
  addTransactions: vi.fn().mockResolvedValue(undefined),
  updateTransaction: vi.fn().mockResolvedValue(undefined),
  deleteTransaction: vi.fn().mockResolvedValue(undefined),
}));

const BUDGET_ID = "test-budget";
const DEST_ACCOUNT = "dest-acct";

function makeEngine(addCount: number): SyncEngine {
  return {
    propose(_sourceTxs, opts): ProposeResult {
      const desired = new Map<string, { accountId: string; tx: NewTransaction }>();
      for (let i = 0; i < addCount; i++) {
        const txId = `tx-${i}`;
        desired.set(`${txId}:${DEST_ACCOUNT}`, {
          accountId: DEST_ACCOUNT,
          tx: {
            date: "2025-01-15",
            amount: -1000,
            imported_id: formatImportedId(BUDGET_ID, txId),
          },
        });
      }
      return { desired };
    },
    getDestBudgetId: () => BUDGET_ID,
    getDestAccountIds: () => [DEST_ACCOUNT],
  };
}

function baseOpts(overrides: Partial<EngineOpts> = {}): EngineOpts {
  return {
    sourceBudgetAlias: "test",
    sourceBudgetId: BUDGET_ID,
    sourceAccountsSpec: "all",
    destBudgetAlias: "test",
    destBudgetId: BUDGET_ID,
    destAccountIds: [DEST_ACCOUNT],
    lookbackDays: 60,
    dryRun: false,
    stepType: "mirror",
    ...overrides,
  };
}

const mockManager = {
  open: vi.fn().mockResolvedValue({ alias: "test", budgetId: BUDGET_ID, syncId: BUDGET_ID }),
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("circuit breaker", () => {
  it("throws when changes exceed maxChangesPerStep", async () => {
    const engine = makeEngine(10);
    const opts = baseOpts({ maxChangesPerStep: 5 });
    await expect(runSyncEngine(engine, opts, mockManager)).rejects.toThrow(
      /Circuit breaker.*10 changes.*limit is 5/
    );
  });

  it("does not throw when maxChangesPerStep is 0 (disabled)", async () => {
    const engine = makeEngine(10);
    const opts = baseOpts({ maxChangesPerStep: 0 });
    await expect(runSyncEngine(engine, opts, mockManager)).resolves.not.toThrow();
  });

  it("does not throw when maxChangesPerStep is undefined (disabled)", async () => {
    const engine = makeEngine(10);
    const opts = baseOpts({ maxChangesPerStep: undefined });
    await expect(runSyncEngine(engine, opts, mockManager)).resolves.not.toThrow();
  });

  it("does not throw when changes equal maxChangesPerStep (at limit)", async () => {
    const engine = makeEngine(10);
    const opts = baseOpts({ maxChangesPerStep: 10 });
    await expect(runSyncEngine(engine, opts, mockManager)).resolves.not.toThrow();
  });
});
