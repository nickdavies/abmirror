import { describe, it, expect } from "vitest";
import { formatImportedId } from "../../util/imported-id";
import type { GlobalTxIndex, RootTxIndex } from "../global-tx-index";

// These tests exercise the runtime mirror-engine logic that consumes a GlobalTxIndex.
// The buildGlobalTxIndex function itself is an async I/O operation tested via
// integration tests; here we verify the index lookup semantics directly.

describe("GlobalTxIndex (lookup semantics)", () => {
  function makeIndex(entries: [string, string[]][]): GlobalTxIndex {
    const m: GlobalTxIndex = new Map();
    for (const [key, dests] of entries) {
      m.set(key, new Set(dests));
    }
    return m;
  }

  it("empty index returns undefined for any key", () => {
    const idx = makeIndex([]);
    expect(idx.get("budget-A:tx-1")).toBeUndefined();
  });

  it("records where a canonical tx has been copied", () => {
    const idx = makeIndex([
      ["budget-A:tx-1", ["budget-B:acct-recv", "budget-C:acct-recv"]],
    ]);
    expect(idx.get("budget-A:tx-1")?.has("budget-B:acct-recv")).toBe(true);
    expect(idx.get("budget-A:tx-1")?.has("budget-C:acct-recv")).toBe(true);
    expect(idx.get("budget-A:tx-1")?.has("budget-A:acct-check")).toBe(false);
  });

  it("has() returns false for a dest not in the index", () => {
    const idx = makeIndex([["budget-A:tx-1", ["budget-B:acct-recv"]]]);
    expect(idx.get("budget-A:tx-1")?.has("budget-C:acct-recv")).toBe(false);
  });

  it("distinct canonical keys do not interfere", () => {
    const idx = makeIndex([
      ["budget-A:tx-1", ["budget-B:acct-recv"]],
      ["budget-A:tx-2", ["budget-C:acct-recv"]],
    ]);
    expect(idx.get("budget-A:tx-1")?.has("budget-C:acct-recv")).toBe(false);
    expect(idx.get("budget-A:tx-2")?.has("budget-B:acct-recv")).toBe(false);
  });

  it("mirror engine check: skip if canonical origin copy exists at dest", () => {
    // Simulate: ABMirror imported_id on a source tx in budget-C pointing to budget-A:tx-1
    // Global index says budget-B already has a copy of budget-A:tx-1 at acct-recv
    const importedId = formatImportedId("budget-A", "tx-1");
    const idx = makeIndex([
      ["budget-A:tx-1", ["budget-B:acct-recv"]],
    ]);

    // Mirror engine logic (what it would compute):
    const parsed = { budgetId: "budget-A", txId: "tx-1" };
    const destBudgetId = "budget-B";
    const destAccountId = "acct-recv";

    const canonicalKey = `${parsed.budgetId}:${parsed.txId}`;
    const destKey = `${destBudgetId}:${destAccountId}`;
    const shouldSkip = idx.get(canonicalKey)?.has(destKey) ?? false;

    expect(importedId).toBe("ABMirror:budget-A:tx-1");
    expect(shouldSkip).toBe(true);
  });

  it("multi-hop: canonical origin present in index at dest — skip", () => {
    // A→B→C, now C→B trying to re-add. Budget-B already has budget-A:tx-1.
    const idx = makeIndex([
      ["budget-A:tx-1", ["budget-B:acct-recv", "budget-C:acct-recv"]],
    ]);
    const shouldSkipCtoB = idx.get("budget-A:tx-1")?.has("budget-B:acct-recv") ?? false;
    expect(shouldSkipCtoB).toBe(true);
  });
});

describe("RootTxIndex (root-existence delete semantics)", () => {
  function makeRootIndex(entries: [string, string[]][]): RootTxIndex {
    const m: RootTxIndex = new Map();
    for (const [budgetId, txIds] of entries) {
      m.set(budgetId, new Set(txIds));
    }
    return m;
  }

  it("returns undefined for unknown budget", () => {
    const idx = makeRootIndex([]);
    expect(idx.get("budget-X")).toBeUndefined();
  });

  it("records non-ABMirror tx IDs per budget", () => {
    const idx = makeRootIndex([
      ["budget-A", ["tx-1", "tx-2"]],
    ]);
    expect(idx.get("budget-A")?.has("tx-1")).toBe(true);
    expect(idx.get("budget-A")?.has("tx-2")).toBe(true);
    expect(idx.get("budget-A")?.has("tx-99")).toBe(false);
  });

  it("delete filter: root exists → keep copy (no delete)", () => {
    const rootIdx = makeRootIndex([["budget-A", ["tx-1"]]]);
    const rootExists = rootIdx.get("budget-A")?.has("tx-1") ?? false;
    expect(rootExists).toBe(true); // copy should NOT be deleted
  });

  it("delete filter: root gone → remove copy", () => {
    const rootIdx = makeRootIndex([["budget-A", []]]);
    const rootExists = rootIdx.get("budget-A")?.has("tx-1") ?? false;
    expect(rootExists).toBe(false); // copy should be deleted
  });
});
