import { describe, it, expect } from "vitest";
import { computeSyncDiff } from "../syncer/index";
import { formatImportedId } from "../util/imported-id";
import type { ActualTransaction } from "../selector/types";
import type { MirrorStep } from "../config/schema";

const BUDGET_ID = "TestBudget-1234";
const DEST_ACCOUNT = "dest-acct";

// Minimal MirrorStep for tests
const baseStep: MirrorStep = {
  type: "mirror",
  source: { budget: "src", accounts: "all" },
  destination: { budget: "dst", account: DEST_ACCOUNT },
  invert: false,
  delete: false,
};

const mkTx = (id: string, overrides: Partial<ActualTransaction> = {}): ActualTransaction => ({
  id,
  account: "src-acct",
  date: "2025-01-15",
  amount: -10000,
  notes: null,
  category: null,
  ...overrides,
});

describe("computeSyncDiff", () => {
  it("adds new transactions not yet in destination", () => {
    const sourceTx = mkTx("src-1", { payee_name: "Grocery", amount: -5000 });
    const diff = computeSyncDiff([sourceTx], new Map(), DEST_ACCOUNT, BUDGET_ID, baseStep);

    expect(diff.toAdd).toHaveLength(1);
    expect(diff.toAdd[0]?.imported_id).toBe(formatImportedId(BUDGET_ID, "src-1"));
    expect(diff.toAdd[0]?.amount).toBe(-5000);
    expect(diff.toUpdate).toHaveLength(0);
    expect(diff.toDelete).toHaveLength(0);
  });

  it("skips unchanged transactions already mirrored", () => {
    const sourceTx = mkTx("src-1", { amount: -5000 });
    const existingTx = mkTx("dest-1", {
      id: "dest-1",
      amount: -5000,
      date: "2025-01-15",
      imported_id: formatImportedId(BUDGET_ID, "src-1"),
    });
    const existing = new Map([["src-1", existingTx]]);

    const diff = computeSyncDiff([sourceTx], existing, DEST_ACCOUNT, BUDGET_ID, baseStep);
    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(0);
  });

  it("updates date and amount when source changes", () => {
    const sourceTx = mkTx("src-1", { amount: -6000, date: "2025-01-20" });
    const existingTx = mkTx("dest-1", {
      id: "dest-1",
      amount: -5000,
      date: "2025-01-15",
    });
    const existing = new Map([["src-1", existingTx]]);

    const diff = computeSyncDiff([sourceTx], existing, DEST_ACCOUNT, BUDGET_ID, baseStep);
    expect(diff.toUpdate).toHaveLength(1);
    expect(diff.toUpdate[0]).toMatchObject({ id: "dest-1", amount: -6000, date: "2025-01-20" });
  });

  it("inverts amount when step.invert is true", () => {
    const sourceTx = mkTx("src-1", { amount: -5000 });
    const step = { ...baseStep, invert: true };

    const diff = computeSyncDiff([sourceTx], new Map(), DEST_ACCOUNT, BUDGET_ID, step);
    expect(diff.toAdd[0]?.amount).toBe(5000);
  });

  it("queues deletion for mirrored transactions whose source is gone (delete mode)", () => {
    const step = { ...baseStep, delete: true };
    const existingTx = mkTx("dest-1", { id: "dest-1" });
    const existing = new Map([["src-1", existingTx]]);

    // No matching source transactions
    const diff = computeSyncDiff([], existing, DEST_ACCOUNT, BUDGET_ID, step);
    expect(diff.toDelete).toEqual(["dest-1"]);
  });

  it("does not delete when delete mode is off", () => {
    const existingTx = mkTx("dest-1", { id: "dest-1" });
    const existing = new Map([["src-1", existingTx]]);

    const diff = computeSyncDiff([], existing, DEST_ACCOUNT, BUDGET_ID, baseStep);
    expect(diff.toDelete).toHaveLength(0);
  });

  it("applies categoryMapping on creation only", () => {
    const step = {
      ...baseStep,
      categoryMapping: { "src-cat": "dest-cat" },
    };
    const sourceTx = mkTx("src-1", { category: "src-cat" });

    const diff = computeSyncDiff([sourceTx], new Map(), DEST_ACCOUNT, BUDGET_ID, step);
    expect(diff.toAdd[0]?.category).toBe("dest-cat");
  });

  it("leaves category undefined for unmapped source category", () => {
    const step = {
      ...baseStep,
      categoryMapping: { "other-cat": "dest-cat" },
    };
    const sourceTx = mkTx("src-1", { category: "src-cat" });

    const diff = computeSyncDiff([sourceTx], new Map(), DEST_ACCOUNT, BUDGET_ID, step);
    expect(diff.toAdd[0]?.category).toBeUndefined();
  });
});
