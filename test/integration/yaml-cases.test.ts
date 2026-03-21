/**
 * YAML-driven integration tests for the ab-mirror sync engine.
 *
 * Auto-discovers test cases from test/integration/cases/<name>/ directories.
 * Each case needs three files:
 *   before.yaml   — initial state (budgets / accounts / transactions)
 *   pipeline.yaml — pipeline steps (mirror / split)
 *   after.yaml    — expected settled state
 *
 * The real runSyncEngine + SyncEngine implementations are exercised against an
 * in-memory RuntimeEnv. @actual-app/api is mocked to serve that env.
 *
 * Settling: the pipeline is run N+1 times (N = step count) to propagate
 * multi-step dependencies, then once more with a strict "no changes" assertion.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { readFileSync } from "node:fs";

// ─── @actual-app/api mock ─────────────────────────────────────────────────────
// Must be at top level (vi.mock is hoisted). The factory uses a dynamic import
// to avoid hoisting-related reference issues.

vi.mock("@actual-app/api", async () => {
  const { mockState, resetChangeCount } = await import(
    "./lib/actual-mock-state"
  );
  const { getAccountTransactions, findTransactionGlobally } = await import(
    "./lib/runtime"
  );
  const { randomUUID } = await import("node:crypto");

  function currentBudget() {
    if (!mockState.env || !mockState.openAlias) return null;
    return mockState.env.budgets.get(mockState.openAlias) ?? null;
  }

  return {
    // ── Read operations ──────────────────────────────────────────────────────

    getAccounts: async () => {
      const budget = currentBudget();
      if (!budget) return [];
      return Array.from(budget.accounts.values()).map((a) => ({
        id: a.id,
        name: a.name,
        offbudget: a.offbudget,
        closed: a.closed,
      }));
    },

    getTransactions: async (
      accountId: string,
      startDate: string,
      endDate: string
    ) => {
      const budget = currentBudget();
      if (!budget) return [];
      const account = budget.accounts.get(accountId);
      if (!account) return [];
      return getAccountTransactions(account, startDate, endDate).map((tx) => ({
        ...tx,
        account: accountId,
        subtransactions: tx.subtransactions?.map((sub) => ({
          ...sub,
          account: accountId,
        })),
      }));
    },

    // ── Write operations (increment changeCount so runOneRound can detect work) ─

    addTransactions: async (
      accountId: string,
      txs: Array<Record<string, unknown>>
    ): Promise<string[]> => {
      const budget = currentBudget();
      if (!budget) return [];
      const account = budget.accounts.get(accountId);
      if (!account) throw new Error(`addTransactions: account ${accountId} not found`);

      const ids: string[] = [];
      for (const tx of txs) {
        const id = randomUUID();
        account.transactions.set(id, {
          id,
          date: tx["date"] as string,
          amount: (tx["amount"] as number) ?? 0,
          payee_name: (tx["payee_name"] as string | null | undefined) ?? null,
          notes: (tx["notes"] as string | null | undefined) ?? null,
          category: (tx["category"] as string | null | undefined) ?? null,
          cleared: (tx["cleared"] as boolean | null | undefined) ?? null,
          imported_id: (tx["imported_id"] as string | null | undefined) ?? null,
        });
        ids.push(id);
        mockState.changeCount++;
      }
      return ids;
    },

    updateTransaction: async (
      id: string,
      changes: { date?: string; amount?: number }
    ): Promise<void> => {
      const found = mockState.env
        ? findTransactionGlobally(mockState.env, id)
        : null;
      if (!found) throw new Error(`updateTransaction: tx ${id} not found`);
      if (changes.date !== undefined) found.tx.date = changes.date;
      if (changes.amount !== undefined) found.tx.amount = changes.amount;
      mockState.changeCount++;
    },

    deleteTransaction: async (id: string): Promise<void> => {
      const found = mockState.env
        ? findTransactionGlobally(mockState.env, id)
        : null;
      if (!found) throw new Error(`deleteTransaction: tx ${id} not found`);
      found.tx.tombstone = true;
      mockState.changeCount++;
    },

    // ── Lifecycle no-ops ─────────────────────────────────────────────────────
    init: async () => {},
    sync: async () => {},
    loadBudget: async () => {},
    downloadBudget: async () => {},
    getBudgets: async () => [],
    shutdown: async () => {},
  };
});

// ─── Test imports (after mock declaration) ─────────────────────────────────────

import {
  loadFixture,
  loadExpectedFixture,
  assertMatchesExpected,
  importFixtureToRuntime,
  exportRuntimeToFixture,
  diffFixtureSnapshots,
  type FixtureSnapshot,
} from "./lib/fixture";
import {
  runInMemoryPipeline,
  runOneRoundInMemory,
  type InMemoryStep,
} from "./lib/pipeline-runner";
import { setMockEnv } from "./lib/actual-mock-state";

// ─── Case discovery ───────────────────────────────────────────────────────────

const CASES_DIR = path.resolve(__dirname, "cases");

type CaseEntry = {
  name: string;
  beforePath: string;
  afterPath: string;
  pipelinePath: string;
};

function discoverCases(): CaseEntry[] {
  if (!existsSync(CASES_DIR)) return [];
  return readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      name: d.name,
      beforePath: path.join(CASES_DIR, d.name, "before.yaml"),
      afterPath: path.join(CASES_DIR, d.name, "after.yaml"),
      pipelinePath: path.join(CASES_DIR, d.name, "pipeline.yaml"),
    }))
    .filter(
      (c) =>
        existsSync(c.beforePath) &&
        existsSync(c.afterPath) &&
        existsSync(c.pipelinePath)
    );
}

function loadPipeline(pipelinePath: string): InMemoryStep[] {
  const raw = readFileSync(pipelinePath, "utf-8");
  const doc = parse(raw) as { pipeline?: InMemoryStep[] } | InMemoryStep[];
  if (Array.isArray(doc)) return doc;
  return doc.pipeline ?? [];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const cases = discoverCases();

async function logOscillationDiff(
  caseName: string,
  before: FixtureSnapshot,
  steps: InMemoryStep[]
): Promise<void> {
  try {
    const { env, idMap } = importFixtureToRuntime(before);
    setMockEnv(env);

    const settlingRounds = steps.length + 1;

    // Run settling rounds to reach the "before idempotency" state
    for (let i = 0; i < settlingRounds; i++) {
      await runOneRoundInMemory(env, steps);
    }
    const beforeIdempotency = exportRuntimeToFixture(env, idMap);

    // One more round to capture the oscillation
    await runOneRoundInMemory(env, steps);
    const afterIdempotency = exportRuntimeToFixture(env, idMap);

    const diffSummary = diffFixtureSnapshots(beforeIdempotency, afterIdempotency);
    // eslint-disable-next-line no-console
    console.error(
      `\nCase "${caseName}": pipeline oscillation between last two rounds\n` +
        `Diff (what changed):\n${diffSummary}\n`
    );
  } catch (e) {
    // If our debug helper itself fails, at least surface that information.
    // eslint-disable-next-line no-console
    console.error(
      `Failed to compute oscillation diff for case "${caseName}":`,
      e
    );
  }
}

if (cases.length === 0) {
  describe("yaml-cases", () => {
    it("no cases found (add directories to test/integration/cases/)", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("yaml-cases", () => {
    for (const c of cases) {
      describe(c.name, () => {
        it("pipeline settles and matches after.yaml", async () => {
          const before = loadFixture(c.beforePath);
          const expected = loadExpectedFixture(c.afterPath);
          const steps = loadPipeline(c.pipelinePath);

          const { env, idMap } = importFixtureToRuntime(before);

          // Point the mock at this env so @actual-app/api calls hit it
          setMockEnv(env);

          const result = await runInMemoryPipeline(env, steps);

          if (!result.converged) {
            // When the pipeline fails to converge, capture and log the
            // oscillation between the last two rounds to aid debugging.
            await logOscillationDiff(c.name, before, steps);
          }

          expect(
            result.converged,
            `Case "${c.name}": pipeline did not converge after ${result.settlingRounds} settling rounds — possible oscillating loop`
          ).toBe(true);

          const actual = exportRuntimeToFixture(env, idMap);

          assertMatchesExpected(actual, expected);
        });
      });
    }
  });
}

// ─── Roundtrip test ───────────────────────────────────────────────────────────

describe("fixture roundtrip", () => {
  it("importFixtureToRuntime → exportRuntimeToFixture is a no-op for any before.yaml", () => {
    const casesWithBefore = cases.filter((c) => existsSync(c.beforePath));
    if (casesWithBefore.length === 0) return;

    for (const c of casesWithBefore) {
      const original = loadFixture(c.beforePath);
      const { env, idMap } = importFixtureToRuntime(original);
      const roundtripped = exportRuntimeToFixture(env, idMap);

      expect(
        roundtripped,
        `Roundtrip failed for case "${c.name}": import → export changed the fixture`
      ).toEqual(original);
    }
  });
});
