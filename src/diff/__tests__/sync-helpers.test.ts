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

  it("indexes by destBudgetId when passed (dual indexing for round-trip)", () => {
    const tx = mkTx("dest-1", {
      imported_id: formatImportedId("DestBudget", "tx-origin"),
      account: "dest-acct",
    });
    const result = indexExistingMirrored([tx], "SourceBudget", "DestBudget");
    expect(result.size).toBe(1);
    expect(result.get("tx-origin:dest-acct")).toBe(tx);
  });

  it("indexes by both sourceBudgetId and destBudgetId", () => {
    const txSource = mkTx("d1", {
      imported_id: formatImportedId("SourceBudget", "src-1"),
      account: "acct-a",
    });
    const txDest = mkTx("d2", {
      imported_id: formatImportedId("DestBudget", "tx-origin"),
      account: "acct-b",
    });
    const result = indexExistingMirrored(
      [txSource, txDest],
      "SourceBudget",
      "DestBudget"
    );
    expect(result.size).toBe(2);
    expect(result.get("src-1:acct-a")).toBe(txSource);
    expect(result.get("tx-origin:acct-b")).toBe(txDest);
  });

  it("uses parsed.txId:tx.account as key format for both index paths", () => {
    const tx = mkTx("dest-1", {
      imported_id: formatImportedId(BUDGET_ID, "orig-tx-1"),
      account: "my-account-id",
    });
    const result = indexExistingMirrored([tx], BUDGET_ID);
    expect(result.get("orig-tx-1:my-account-id")).toBe(tx);
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

  it("round-trip: existing has canonical key -> no toAdd, no toDelete", () => {
    const desired = new Map<string, { accountId: string; tx: NewTransaction }>();
    desired.set("tx-1:dest-acct", {
      accountId: "dest-acct",
      tx: { date: "2025-01-15", amount: -5000, imported_id: "x" },
    });
    const existing = new Map<string, ActualTransaction>();
    existing.set(
      "tx-1:dest-acct",
      mkTx("dest-1", {
        imported_id: formatImportedId(BUDGET_ID, "tx-1"),
        account: "dest-acct",
        date: "2025-01-15",
        amount: -5000,
      })
    );
    const diff = computeDiff(desired, existing);
    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(0);
    expect(diff.toDelete).toHaveLength(0);
  });

  it("round-trip: existing has tx but date/amount differ -> toUpdate only", () => {
    const desired = new Map<string, { accountId: string; tx: NewTransaction }>();
    desired.set("tx-1:dest-acct", {
      accountId: "dest-acct",
      tx: { date: "2025-01-20", amount: -6000, imported_id: "x" },
    });
    const existing = new Map<string, ActualTransaction>();
    existing.set(
      "tx-1:dest-acct",
      mkTx("dest-1", {
        imported_id: formatImportedId(BUDGET_ID, "tx-1"),
        account: "dest-acct",
        date: "2025-01-15",
        amount: -5000,
      })
    );
    const diff = computeDiff(desired, existing);
    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(1);
    expect(diff.toDelete).toHaveLength(0);
  });

  it("round-trip same-budget: desired has canonical key, existing has tx -> no toDelete", () => {
    const desired = new Map<string, { accountId: string; tx: NewTransaction }>();
    desired.set("tx-1:dest-acct", {
      accountId: "dest-acct",
      tx: { date: "2025-01-15", amount: -5000, imported_id: "x" },
    });
    const existing = new Map<string, ActualTransaction>();
    existing.set(
      "tx-1:dest-acct",
      mkTx("dest-1", {
        imported_id: formatImportedId(BUDGET_ID, "tx-1"),
        account: "dest-acct",
      })
    );
    const diff = computeDiff(desired, existing);
    expect(diff.toDelete).toHaveLength(0);
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
