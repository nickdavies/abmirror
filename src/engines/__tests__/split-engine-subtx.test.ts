import { describe, it, expect } from "vitest";
import { createSplitEngine } from "../split-engine";
import { selectTransactions } from "../../selector/index";
import { formatImportedId } from "../../util/imported-id";
import type { ActualTransaction } from "../../selector/types";
import type { SplitStep } from "../../config/schema";
import type { EngineOpts } from "../../diff/sync-engine";

const BUDGET_ID = "budget-A";
const DEST_ACCOUNT = "dest-acct";

const mkTx = (
  id: string,
  opts: Partial<ActualTransaction> = {}
): ActualTransaction => ({
  id,
  account: "src-acct",
  date: "2025-01-15",
  amount: -10000,
  notes: null,
  ...opts,
});

const step: SplitStep = {
  type: "split",
  budget: "main",
  source: { accounts: "all", requiredTags: ["#sync"] },
  tags: {
    "#50/50": { multiplier: -0.5, destination_account: DEST_ACCOUNT },
  },
  delete: false,
  updateFields: false,
};

function baseOpts(overrides: Partial<EngineOpts> = {}): EngineOpts {
  return {
    sourceBudgetAlias: "main",
    sourceBudgetId: BUDGET_ID,
    sourceAccountsSpec: "all",
    destBudgetAlias: "main",
    destBudgetId: BUDGET_ID,
    destAccountIds: [DEST_ACCOUNT],
    startDate: "2024-11-17",
    endDate: "2025-01-15",
    dryRun: false,
    stepType: "split",
    tagEntries: [["#50/50", { multiplier: -0.5, destination_account: DEST_ACCOUNT }]],
    ...overrides,
  };
}

describe("split engine with subtransactions", () => {
  it("routes matching subtransactions through split engine correctly", () => {
    const parent = mkTx("parent-1", {
      is_parent: true,
      notes: "parent note",
      subtransactions: [
        mkTx("sub-1", { id: "sub-1", notes: "#sync #50/50 groceries", amount: -6000 }),
        mkTx("sub-2", { id: "sub-2", notes: "#sync no-action-tag", amount: -4000 }),
      ],
    });

    // selectTransactions yields subtransactions individually
    const selector = { accounts: "all" as const, requiredTags: ["#sync"] };
    const filtered = [...selectTransactions([parent], selector)];

    expect(filtered.map((t) => t.id)).toEqual(["sub-1", "sub-2"]);

    const engine = createSplitEngine(step);
    const { desired } = engine.propose(filtered, baseOpts());

    // sub-1 has #50/50 → routed to dest with multiplier
    const sub1Entry = desired.get(`sub-1:${DEST_ACCOUNT}`);
    expect(sub1Entry).toBeDefined();
    expect(sub1Entry!.accountId).toBe(DEST_ACCOUNT);
    expect(sub1Entry!.tx.amount).toBe(Math.round(-6000 * -0.5));
    expect(sub1Entry!.tx.imported_id).toBe(formatImportedId(BUDGET_ID, "sub-1"));
    expect(sub1Entry!.tx.date).toBe("2025-01-15");

    // sub-2 has #sync but no matching action tag → not in desired (no default action)
    expect(desired.has(`sub-2:${DEST_ACCOUNT}`)).toBe(false);

    expect(desired.size).toBe(1);
  });

  it("subtransactions use their own id, not parent id, in imported_id", () => {
    const parent = mkTx("parent-2", {
      is_parent: true,
      subtransactions: [
        mkTx("sub-A", { id: "sub-A", notes: "#sync #50/50", amount: -2000 }),
      ],
    });

    const filtered = [...selectTransactions([parent], { accounts: "all", requiredTags: ["#sync"] })];
    const engine = createSplitEngine(step);
    const { desired } = engine.propose(filtered, baseOpts());

    const entry = desired.get(`sub-A:${DEST_ACCOUNT}`);
    expect(entry).toBeDefined();
    // imported_id should reference the subtransaction id, not the parent
    expect(entry!.tx.imported_id).toBe(formatImportedId(BUDGET_ID, "sub-A"));
    expect(entry!.tx.imported_id).not.toContain("parent-2");
  });

  it("subtransactions with default action get routed correctly", () => {
    const stepWithDefault: SplitStep = {
      ...step,
      default: { multiplier: -0.5, destination_account: DEST_ACCOUNT },
    };

    const parent = mkTx("parent-3", {
      is_parent: true,
      subtransactions: [
        mkTx("sub-default", { id: "sub-default", notes: "#sync no-known-tag", amount: -8000 }),
      ],
    });

    const filtered = [...selectTransactions([parent], { accounts: "all", requiredTags: ["#sync"] })];
    const engine = createSplitEngine(stepWithDefault);
    const opts = baseOpts({
      defaultAction: { multiplier: -0.5, destination_account: DEST_ACCOUNT },
    });
    const { desired } = engine.propose(filtered, opts);

    // Default action: logicalId = "sub-default::default::<destAccountId>"
    const logicalId = `sub-default::default::${DEST_ACCOUNT}`;
    const key = `${logicalId}:${DEST_ACCOUNT}`;
    const entry = desired.get(key);
    expect(entry).toBeDefined();
    expect(entry!.tx.amount).toBe(Math.round(-8000 * -0.5));
    expect(entry!.tx.imported_id).toBe(formatImportedId(BUDGET_ID, logicalId));
  });
});
