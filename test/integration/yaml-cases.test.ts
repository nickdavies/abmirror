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
      // Exclude payee_name from output — real Actual API only returns payee (UUID).
      return getAccountTransactions(account, startDate, endDate).map((tx) => {
        const { payee_name: _, ...rest } = tx;
        return {
          ...rest,
          account: accountId,
          subtransactions: tx.subtransactions?.map((sub) => {
            const { payee_name: __, ...subRest } = sub;
            return { ...subRest, account: accountId };
          }),
        };
      });
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

        // Resolve payee like the real API's resolvePayee:
        // payee (UUID) takes precedence over payee_name (string).
        let payeeId: string | null = null;
        let payeeName: string | null = null;
        const rawPayee = tx["payee"] as string | null | undefined;
        const rawPayeeName = tx["payee_name"] as string | null | undefined;

        if (rawPayee) {
          payeeId = rawPayee;
          // Resolve name: try current budget, then search all budgets (cross-budget convenience)
          payeeName = budget.payees.get(rawPayee) ?? null;
          if (!payeeName && mockState.env) {
            for (const b of mockState.env.budgets.values()) {
              const name = b.payees.get(rawPayee);
              if (name) {
                payeeName = name;
                budget.payees.set(rawPayee, name);
                budget.payeesByName.set(name, rawPayee);
                break;
              }
            }
          }
        } else if (rawPayeeName) {
          payeeId = budget.payeesByName.get(rawPayeeName) ?? null;
          if (!payeeId) {
            payeeId = randomUUID();
            budget.payees.set(payeeId, rawPayeeName);
            budget.payeesByName.set(rawPayeeName, payeeId);
          }
          payeeName = rawPayeeName;
        }

        account.transactions.set(id, {
          id,
          date: tx["date"] as string,
          amount: (tx["amount"] as number) ?? 0,
          payee: payeeId,
          payee_name: payeeName,
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
      changes: Record<string, unknown>
    ): Promise<void> => {
      const found = mockState.env
        ? findTransactionGlobally(mockState.env, id)
        : null;
      if (!found) throw new Error(`updateTransaction: tx ${id} not found`);
      if (changes.date !== undefined) found.tx.date = changes.date as string;
      if (changes.amount !== undefined) found.tx.amount = changes.amount as number;
      if (changes.payee !== undefined) {
        found.tx.payee = changes.payee as string | null;
        if (changes.payee) {
          // Resolve UUID → name: try local budget, then search all budgets
          let name = found.budget.payees.get(changes.payee as string) ?? null;
          if (!name && mockState.env) {
            for (const b of mockState.env.budgets.values()) {
              const n = b.payees.get(changes.payee as string);
              if (n) {
                name = n;
                found.budget.payees.set(changes.payee as string, n);
                found.budget.payeesByName.set(n, changes.payee as string);
                break;
              }
            }
          }
          found.tx.payee_name = name;
        } else {
          found.tx.payee_name = null;
        }
      }
      if (changes.notes !== undefined) found.tx.notes = changes.notes as string | null;
      if (changes.category !== undefined) found.tx.category = changes.category as string | null;
      if (changes.cleared !== undefined) found.tx.cleared = changes.cleared as boolean | null;
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

    // ── Payee operations ──────────────────────────────────────────────────────

    getPayees: async () => {
      const budget = currentBudget();
      if (!budget) return [];
      return [...budget.payees.entries()].map(([id, name]) => ({
        id,
        name,
        transfer_acct: null,
      }));
    },

    createPayee: async (payee: { name: string }) => {
      const budget = currentBudget();
      if (!budget) throw new Error("createPayee: no budget open");
      const id = randomUUID();
      budget.payees.set(id, payee.name);
      budget.payeesByName.set(payee.name, id);
      return id;
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

/**
 * Sort transactions by id within each account so comparison is order-independent.
 */
function sortFixtureTxsById(snapshot: FixtureSnapshot): FixtureSnapshot {
  const budgets: Record<string, { accounts: Record<string, { offbudget?: boolean; closed?: boolean; transactions: unknown[] }> }> = {};
  for (const [alias, budget] of Object.entries(snapshot.budgets)) {
    const accounts: Record<string, { offbudget?: boolean; closed?: boolean; transactions: unknown[] }> = {};
    for (const [name, account] of Object.entries(budget.accounts)) {
      accounts[name] = {
        ...account,
        transactions: [...account.transactions].sort((a, b) => a.id.localeCompare(b.id)),
      };
    }
    budgets[alias] = { accounts };
  }
  return { budgets } as FixtureSnapshot;
}

describe("fixture roundtrip", () => {
  it("importFixtureToRuntime → exportRuntimeToFixture preserves all transactions", () => {
    const casesWithBefore = cases.filter((c) => existsSync(c.beforePath));
    if (casesWithBefore.length === 0) return;

    for (const c of casesWithBefore) {
      const original = loadFixture(c.beforePath);
      const { env, idMap } = importFixtureToRuntime(original);
      const roundtripped = exportRuntimeToFixture(env, idMap);

      expect(
        sortFixtureTxsById(roundtripped),
        `Roundtrip failed for case "${c.name}": import → export changed transaction data`
      ).toEqual(sortFixtureTxsById(original));
    }
  });
});
