import { describe, it, expect, vi } from "vitest";
import { computeSplitDiff } from "../splitter/index";
import { formatImportedId } from "../util/imported-id";
import type { ActualTransaction } from "../selector/types";
import type { TagAction } from "../config/schema";

const BUDGET_ID = "TestBudget-5678";

const mkTx = (id: string, overrides: Partial<ActualTransaction> = {}): ActualTransaction => ({
  id,
  account: "acct-1",
  date: "2025-03-01",
  amount: -10000,
  notes: null,
  category: null,
  ...overrides,
});

const tagEntries: Array<[string, TagAction]> = [
  ["#50/50", { multiplier: -0.5, destination_account: "dest-acct" }],
  ["#0/100", { multiplier: -1.0, destination_account: "dest-acct" }],
];

const selector = { accounts: "all" as const };

describe("computeSplitDiff", () => {
  it("creates a new transaction for matching action tag", () => {
    const tx = mkTx("t1", { notes: "#joint #50/50", amount: -10000 });
    const diff = computeSplitDiff([tx], selector, tagEntries, new Map(), BUDGET_ID);

    expect(diff.toAdd).toHaveLength(1);
    expect(diff.toAdd[0]?.accountId).toBe("dest-acct");
    expect(diff.toAdd[0]?.tx.amount).toBe(5000); // -10000 * -0.5
    expect(diff.toAdd[0]?.tx.imported_id).toBe(formatImportedId(BUDGET_ID, "t1"));
  });

  it("skips transaction when multiple action tags match (always exclusive)", () => {
    const tx = mkTx("t1", { notes: "#50/50 #0/100", amount: -10000 });
    const diff = computeSplitDiff([tx], selector, tagEntries, new Map(), BUDGET_ID);

    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(0);
  });

  it("skips transactions with no matching action tags", () => {
    const tx = mkTx("t1", { notes: "#joint" });
    const diff = computeSplitDiff([tx], selector, tagEntries, new Map(), BUDGET_ID);
    expect(diff.toAdd).toHaveLength(0);
  });

  it("skips when requiredTags are not met", () => {
    const selectorWithRequired = { accounts: "all" as const, requiredTags: ["#joint"] };
    const tx = mkTx("t1", { notes: "#50/50" }); // has action tag but not #joint
    const diff = computeSplitDiff([tx], selectorWithRequired, tagEntries, new Map(), BUDGET_ID);
    expect(diff.toAdd).toHaveLength(0);
  });

  it("updates date and amount for existing mirrored transaction", () => {
    const tx = mkTx("t1", { notes: "#50/50", amount: -20000, date: "2025-04-01" });
    const existing = mkTx("dest-1", {
      id: "dest-1",
      amount: -5000, // was -10000 * -0.5
      date: "2025-03-01",
    });
    const existingMap = new Map([["t1:dest-acct", existing]]);

    const diff = computeSplitDiff([tx], selector, tagEntries, existingMap, BUDGET_ID);
    expect(diff.toUpdate).toHaveLength(1);
    expect(diff.toUpdate[0]).toMatchObject({
      id: "dest-1",
      amount: 10000, // -20000 * -0.5
      date: "2025-04-01",
    });
  });

  it("copies category from source (same budget)", () => {
    const tx = mkTx("t1", { notes: "#50/50", category: "food-cat" });
    const diff = computeSplitDiff([tx], selector, tagEntries, new Map(), BUDGET_ID);
    expect(diff.toAdd[0]?.tx.category).toBe("food-cat");
  });

  it("rounds fractional amounts", () => {
    // -3333 * -0.5 = 1666.5 -> rounded to 1667
    const tx = mkTx("t1", { notes: "#50/50", amount: -3333 });
    const diff = computeSplitDiff([tx], selector, tagEntries, new Map(), BUDGET_ID);
    expect(diff.toAdd[0]?.tx.amount).toBe(1667);
  });

  it("skips ABMirror transactions by default", () => {
    const tx = mkTx("t1", {
      notes: "#50/50",
      imported_id: "ABMirror:some-budget:t1",
    });
    const diff = computeSplitDiff([tx], selector, tagEntries, new Map(), BUDGET_ID);
    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(0);
  });

  it("includes ABMirror when splitMirrored true", () => {
    const tx = mkTx("t1", {
      notes: "#50/50",
      imported_id: "ABMirror:some-budget:t1",
    });
    const diff = computeSplitDiff(
      [tx],
      selector,
      tagEntries,
      new Map(),
      BUDGET_ID,
      { splitMirrored: true }
    );
    expect(diff.toAdd).toHaveLength(1);
    expect(diff.toAdd[0]?.tx.amount).toBe(5000);
  });

  it("calls onWarn for multi-tag match and skips transaction", () => {
    const onWarn = vi.fn();
    const tx = mkTx("t1", {
      notes: "#50/50 #0/100",
      payee_name: "Coffee",
      date: "2025-03-14",
    });
    const diff = computeSplitDiff([tx], selector, tagEntries, new Map(), BUDGET_ID, {
      onWarn,
    });
    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(0);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledWith("splitter.multiTagMatch", {
      txId: "t1",
      payee: "Coffee",
      date: "2025-03-14",
      matchingTags: ["#50/50", "#0/100"],
    });
  });

  it("composite key: lookup finds correct copy per destination account", () => {
    const tx = mkTx("t1", { notes: "#50/50", amount: -10000 });
    const existingInA = mkTx("dest-a", {
      id: "dest-a",
      amount: -5000,
      date: "2025-03-01",
    });
    const existingMap = new Map([
      ["t1:acct-a", existingInA],
      ["t1:dest-acct", mkTx("dest-b", { id: "dest-b", amount: -5000, date: "2025-03-01" })],
    ]);
    const diff = computeSplitDiff([tx], selector, tagEntries, existingMap, BUDGET_ID);
    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(1);
    expect(diff.toUpdate[0]?.id).toBe("dest-b");
  });

  it("calls onWarn for scope match but no action tag", () => {
    const onWarn = vi.fn();
    const tx = mkTx("t1", { notes: "#joint" });
    computeSplitDiff([tx], selector, tagEntries, new Map(), BUDGET_ID, {
      onWarn,
      stepIndex: 2,
    });
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledWith("splitter.scopeMatchNoActionTag", {
      stepIndex: 2,
      count: 1,
    });
  });
});
