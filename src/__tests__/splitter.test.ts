import { describe, it, expect } from "vitest";
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

  it("only applies the first matching action tag", () => {
    // Both #50/50 and #0/100 present, #50/50 comes first in tagEntries
    const tx = mkTx("t1", { notes: "#50/50 #0/100", amount: -10000 });
    const diff = computeSplitDiff([tx], selector, tagEntries, new Map(), BUDGET_ID);

    expect(diff.toAdd).toHaveLength(1);
    expect(diff.toAdd[0]?.tx.amount).toBe(5000); // -0.5 multiplier
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
    const existingMap = new Map([["t1", existing]]);

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
});
