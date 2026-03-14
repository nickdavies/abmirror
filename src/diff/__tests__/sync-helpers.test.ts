import { describe, it, expect } from "vitest";
import {
  indexExistingMirrored,
  computeDiff,
  applyDeletes,
} from "../sync-helpers";
import { formatImportedId } from "../../util/imported-id";
import type { ActualTransaction, NewTransaction } from "../../selector/types";

const BUDGET_ID = "TestBudget-1234";

const mkTx = (id: string, overrides: Partial<ActualTransaction> = {}): ActualTransaction => ({
  id,
  account: "acct-1",
  date: "2025-01-15",
  amount: -10000,
  notes: null,
  category: null,
  ...overrides,
});

describe("indexExistingMirrored", () => {
  it("indexes ABMirror transactions with matching budgetId", () => {
    const tx = mkTx("dest-1", {
      imported_id: formatImportedId(BUDGET_ID, "src-1"),
      account: "dest-acct",
    });
    const result = indexExistingMirrored([tx], BUDGET_ID);
    expect(result.size).toBe(1);
    expect(result.get("src-1:dest-acct")).toBe(tx);
  });

  it("skips non-ABMirror transactions", () => {
    const tx = mkTx("dest-1", { imported_id: "OFXIMPORT:123", account: "dest-acct" });
    const result = indexExistingMirrored([tx], BUDGET_ID);
    expect(result.size).toBe(0);
  });

  it("skips ABMirror transactions with wrong budgetId", () => {
    const tx = mkTx("dest-1", {
      imported_id: formatImportedId("OtherBudget", "src-1"),
      account: "dest-acct",
    });
    const result = indexExistingMirrored([tx], BUDGET_ID);
    expect(result.size).toBe(0);
  });
});

describe("computeDiff", () => {
  it("returns toAdd for keys in desired not in existing", () => {
    const desired = new Map<string, { accountId: string; tx: NewTransaction }>();
    desired.set("src-1:dest-a", {
      accountId: "dest-a",
      tx: { date: "2025-01-15", amount: -5000, imported_id: "x" },
    });
    const diff = computeDiff(desired, new Map());
    expect(diff.toAdd).toHaveLength(1);
    expect(diff.toAdd[0]).toEqual({ accountId: "dest-a", tx: expect.any(Object) });
    expect(diff.toUpdate).toHaveLength(0);
    expect(diff.toDelete).toHaveLength(0);
  });

  it("returns toUpdate for keys in both with different date/amount", () => {
    const desired = new Map<string, { accountId: string; tx: NewTransaction }>();
    desired.set("src-1:dest-a", {
      accountId: "dest-a",
      tx: { date: "2025-01-20", amount: -6000, imported_id: "x" },
    });
    const existing = new Map<string, ActualTransaction>();
    existing.set("src-1:dest-a", mkTx("dest-1", { date: "2025-01-15", amount: -5000 }));
    const diff = computeDiff(desired, existing);
    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(1);
    expect(diff.toUpdate[0]).toMatchObject({ id: "dest-1", date: "2025-01-20", amount: -6000 });
    expect(diff.toDelete).toHaveLength(0);
  });

  it("returns toDelete for keys in existing not in desired", () => {
    const existing = new Map<string, ActualTransaction>();
    const tx = mkTx("dest-1", { imported_id: formatImportedId(BUDGET_ID, "src-1") });
    existing.set("src-1:dest-a", tx);
    const diff = computeDiff(new Map(), existing);
    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(0);
    expect(diff.toDelete).toHaveLength(1);
    expect(diff.toDelete[0]).toBe(tx);
  });
});

describe("applyDeletes", () => {
  it("throws on non-ABMirror transaction", async () => {
    const tx = mkTx("dest-1", { imported_id: "other:id" });
    await expect(applyDeletes([tx], BUDGET_ID)).rejects.toThrow("not an ABMirror transaction");
  });

  it("throws on wrong budgetId", async () => {
    const tx = mkTx("dest-1", { imported_id: formatImportedId("OtherBudget", "src-1") });
    await expect(applyDeletes([tx], BUDGET_ID)).rejects.toThrow("does not match expected");
  });
});
