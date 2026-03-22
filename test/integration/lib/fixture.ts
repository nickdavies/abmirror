/**
 * Fixture snapshot types and import/export helpers for YAML-based integration tests.
 *
 * Transaction IDs in before.yaml are stable user-defined names (e.g. "TX-1", "TX-2").
 * These IDs are used directly as runtime IDs during import, so imported_id values in
 * after.yaml always reference the same IDs that appear in before.yaml.
 *
 * Budget aliases (not UUIDs) are used in imported_id values, making fixtures
 * reproducible across runs and between the in-memory test harness and localdev/snapshot.ts.
 *
 * On export, known transactions keep their original IDs. New engine-created transactions
 * are assigned fresh TX-N IDs starting from max(existing N) + 1.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import {
  isABMirrorId,
  parseImportedId,
  formatImportedId,
} from "../../../src/util/imported-id";
import type {
  RuntimeEnv,
  RuntimeBudget,
  RuntimeAccount,
  RuntimeTransaction,
  RuntimeSubTransaction,
} from "./runtime";

// ─── On-disk snapshot types ───────────────────────────────────────────────────

export type SubSnapshot = {
  id: string;
  date: string;
  amount: number;
  payee_name: string | null;
  notes: string | null;
  category: string | null;
  cleared: boolean | null;
  imported_id: string | null;
};

export type TxSnapshot = {
  id: string;
  date: string;
  amount: number;
  payee_name: string | null;
  notes: string | null;
  category: string | null;
  cleared: boolean | null;
  imported_id: string | null;
  subs: SubSnapshot[];
};

export type AccountSnapshot = {
  offbudget?: boolean;
  closed?: boolean;
  transactions: TxSnapshot[];
};

export type BudgetSnapshot = {
  accounts: Record<string, AccountSnapshot>;
};

export type FixtureSnapshot = {
  budgets: Record<string, BudgetSnapshot>;
};

// ─── Diff (for concise test output) ───────────────────────────────────────────

/**
 * Compare two fixture snapshots and return a short summary of what changed.
 * Used when the pipeline fails to converge so we log only the oscillation delta.
 */
export function diffFixtureSnapshots(
  before: FixtureSnapshot,
  after: FixtureSnapshot
): string {
  const lines: string[] = [];

  const budgetAliases = new Set([
    ...Object.keys(before.budgets ?? {}),
    ...Object.keys(after.budgets ?? {}),
  ]);

  for (const alias of [...budgetAliases].sort()) {
    const bBudget = before.budgets?.[alias];
    const aBudget = after.budgets?.[alias];

    const accountNames = new Set([
      ...Object.keys(bBudget?.accounts ?? {}),
      ...Object.keys(aBudget?.accounts ?? {}),
    ]);

    for (const accountName of [...accountNames].sort()) {
      const bAcct = bBudget?.accounts?.[accountName];
      const aAcct = aBudget?.accounts?.[accountName];

      const bTxs = bAcct?.transactions ?? [];
      const aTxs = aAcct?.transactions ?? [];

      const bById = new Map(bTxs.map((t) => [t.id, t]));
      const aById = new Map(aTxs.map((t) => [t.id, t]));

      const added = aTxs.filter((t) => !bById.has(t.id)).map((t) => t.id);
      const removed = bTxs.filter((t) => !aById.has(t.id)).map((t) => t.id);
      const changed: string[] = [];

      for (const [id, aTx] of aById) {
        const bTx = bById.get(id);
        if (!bTx) continue;
        const fields: string[] = [];
        if (bTx.date !== aTx.date) fields.push(`date ${bTx.date} → ${aTx.date}`);
        if (bTx.amount !== aTx.amount) fields.push(`amount ${bTx.amount} → ${aTx.amount}`);
        if ((bTx.notes ?? null) !== (aTx.notes ?? null)) fields.push("notes");
        if ((bTx.imported_id ?? null) !== (aTx.imported_id ?? null)) fields.push("imported_id");
        if (fields.length) changed.push(`${id} (${fields.join(", ")})`);
      }

      if (added.length || removed.length || changed.length) {
        const parts: string[] = [];
        if (added.length) parts.push(`+${added.join(", +")}`);
        if (removed.length) parts.push(`-${removed.join(", -")}`);
        if (changed.length) parts.push(`~${changed.join("; ")}`);
        lines.push(`${alias}.${accountName}: ${parts.join(" | ")}`);
      }
    }
  }

  if (lines.length === 0) return "(no structural diff)";
  return lines.join("\n");
}

// ─── IdMap ────────────────────────────────────────────────────────────────────

/**
 * Bidirectional mapping between runtime IDs and fixture IDs.
 * For before.yaml transactions these are identity mappings (fixture ID = runtime ID).
 * For engine-created transactions, maps randomUUID → fresh TX-N.
 * Budget alias ↔ runtime budget ID mappings are also stored here.
 */
export type IdMap = {
  /** runtime ID → fixture ID */
  txIdToPlaceholder: Map<string, string>;
  /** fixture ID → runtime ID */
  placeholderToTxId: Map<string, string>;
  /** runtime budget ID (e.g. "budget-src") → alias ("src") */
  budgetIdToAlias: Map<string, string>;
  /** alias → runtime budget ID */
  aliasToBudgetId: Map<string, string>;
};

// ─── Expected snapshot types (content-based, no IDs) ─────────────────────────

/**
 * Content-based expected tx. No `id` field.
 * `imported_id`: undefined = skip check, null = assert null, string = assert exact match.
 * `subs`: if provided, assert subs match content-wise.
 */
export type ExpectedSubSnapshot = {
  amount: number;
  payee_name?: string | null;
  notes?: string | null;
  category?: string | null;
};

export type ExpectedTxSnapshot = {
  date: string;
  amount: number;
  payee_name: string | null;
  notes: string | null;
  category: string | null;
  cleared: boolean | null;
  imported_id?: string | null;
  subs?: ExpectedSubSnapshot[];
};

export type ExpectedAccountSnapshot = { transactions: ExpectedTxSnapshot[] };
export type ExpectedBudgetSnapshot  = { accounts: Record<string, ExpectedAccountSnapshot> };
export type ExpectedFixtureSnapshot = { budgets: Record<string, ExpectedBudgetSnapshot> };

export function loadExpectedFixture(path: string): ExpectedFixtureSnapshot {
  const raw = readFileSync(path, "utf-8");
  return parse(raw) as ExpectedFixtureSnapshot;
}

/**
 * Content-based assertion. For each expected budget/account/tx:
 *  - Find the ONE actual tx matching on (date, amount, payee_name, notes, category, cleared).
 *  - 0 matches → throw "Expected tx not found"
 *  - 2+ matches → throw "Ambiguous match"
 *  - If imported_id is specified (not undefined), assert exact match.
 *  - Assert no extra transactions in actual beyond what expected covers.
 */
export function assertMatchesExpected(
  actual: FixtureSnapshot,
  expected: ExpectedFixtureSnapshot
): void {
  for (const [budgetAlias, expectedBudget] of Object.entries(expected.budgets)) {
    const actualBudget = actual.budgets[budgetAlias];
    if (!actualBudget) {
      throw new Error(`Budget "${budgetAlias}" not found in actual state`);
    }
    for (const [accountName, expectedAccount] of Object.entries(expectedBudget.accounts)) {
      const actualAccount = actualBudget.accounts[accountName];
      if (!actualAccount) {
        throw new Error(`Account "${accountName}" in budget "${budgetAlias}" not found in actual state`);
      }

      const actualTxs = actualAccount.transactions;
      const matchedIds = new Set<string>();

      for (const expectedTx of expectedAccount.transactions) {
        const candidates = actualTxs.filter(
          (tx) =>
            tx.date === expectedTx.date &&
            tx.amount === expectedTx.amount &&
            (tx.payee_name ?? null) === expectedTx.payee_name &&
            (tx.notes ?? null) === expectedTx.notes &&
            (tx.category ?? null) === expectedTx.category &&
            (tx.cleared ?? null) === expectedTx.cleared
        );

        if (candidates.length === 0) {
          throw new Error(
            `Expected tx not found in ${budgetAlias}.${accountName}: ` +
              JSON.stringify({
                date: expectedTx.date,
                amount: expectedTx.amount,
                payee_name: expectedTx.payee_name,
                notes: expectedTx.notes,
                category: expectedTx.category,
              })
          );
        }
        if (candidates.length > 1) {
          throw new Error(
            `Ambiguous match in ${budgetAlias}.${accountName}: ` +
              `${candidates.length} txs match ` +
              JSON.stringify({
                date: expectedTx.date,
                amount: expectedTx.amount,
                payee_name: expectedTx.payee_name,
                notes: expectedTx.notes,
              })
          );
        }

        const matched = candidates[0]!;
        matchedIds.add(matched.id);

        if (expectedTx.imported_id !== undefined) {
          const actualImportedId = matched.imported_id ?? null;
          if (actualImportedId !== expectedTx.imported_id) {
            throw new Error(
              `imported_id mismatch in ${budgetAlias}.${accountName} for tx ` +
                `{date: ${expectedTx.date}, amount: ${expectedTx.amount}, payee: ${expectedTx.payee_name}}: ` +
                `expected ${JSON.stringify(expectedTx.imported_id)}, got ${JSON.stringify(actualImportedId)}`
            );
          }
        }

        if (expectedTx.subs !== undefined) {
          const actualSubs = matched.subs ?? [];
          assertSubsMatch(actualSubs, expectedTx.subs, `${budgetAlias}.${accountName}`, matched.id);
        }
      }

      // No extra transactions
      const unmatched = actualTxs.filter((tx) => !matchedIds.has(tx.id));
      if (unmatched.length > 0) {
        const desc = unmatched
          .map((t) => JSON.stringify({ date: t.date, amount: t.amount, payee_name: t.payee_name }))
          .join(", ");
        throw new Error(
          `Extra transactions in ${budgetAlias}.${accountName} not covered by expected: ${desc}`
        );
      }
    }
  }
}

function assertSubsMatch(
  actualSubs: SubSnapshot[],
  expectedSubs: ExpectedSubSnapshot[],
  location: string,
  parentId: string
): void {
  const matched = new Set<number>();
  for (const expectedSub of expectedSubs) {
    const candidates: number[] = [];
    for (let i = 0; i < actualSubs.length; i++) {
      const a = actualSubs[i]!;
      if (
        a.amount === expectedSub.amount &&
        (expectedSub.payee_name === undefined || (a.payee_name ?? null) === expectedSub.payee_name) &&
        (expectedSub.notes === undefined || (a.notes ?? null) === expectedSub.notes) &&
        (expectedSub.category === undefined || (a.category ?? null) === expectedSub.category)
      ) {
        candidates.push(i);
      }
    }
    if (candidates.length === 0) {
      throw new Error(
        `Expected sub not found in ${location} parent ${parentId}: ` +
          JSON.stringify(expectedSub)
      );
    }
    if (candidates.filter((i) => !matched.has(i)).length === 0) {
      throw new Error(
        `Ambiguous sub match in ${location} parent ${parentId}: ` +
          JSON.stringify(expectedSub)
      );
    }
    matched.add(candidates.find((i) => !matched.has(i))!);
  }
}

// ─── File I/O ─────────────────────────────────────────────────────────────────

export function loadFixture(path: string): FixtureSnapshot {
  const raw = readFileSync(path, "utf-8");
  return parse(raw) as FixtureSnapshot;
}

export function saveFixture(snapshot: FixtureSnapshot, path: string): void {
  writeFileSync(path, stringify(snapshot, { lineWidth: 0 }), "utf-8");
}

// ─── Deterministic runtime IDs ────────────────────────────────────────────────

/** Stable runtime budget ID derived from alias (never changes). */
export function runtimeBudgetId(alias: string): string {
  return `budget-${alias}`;
}

/** Stable runtime account ID derived from budget alias + account name. */
export function runtimeAccountId(budgetAlias: string, accountName: string): string {
  return `acct-${budgetAlias}-${accountName}`;
}

// ─── importFixtureToRuntime ───────────────────────────────────────────────────

/**
 * Load a FixtureSnapshot into a live RuntimeEnv.
 * Returns the env together with an IdMap so callers can carry the budget↔alias
 * and transaction ID mappings into exportRuntimeToFixture.
 *
 * Fixture IDs are used directly as runtime IDs (e.g. "TX-1" stays "TX-1").
 * Pass 1 builds all structures; Pass 2 rewrites imported_id budget references.
 */
export function importFixtureToRuntime(fixture: FixtureSnapshot): {
  env: RuntimeEnv;
  idMap: IdMap;
} {
  const idMap: IdMap = {
    txIdToPlaceholder: new Map(),
    placeholderToTxId: new Map(),
    budgetIdToAlias: new Map(),
    aliasToBudgetId: new Map(),
  };

  const env: RuntimeEnv = { budgets: new Map() };
  const seenIds = new Set<string>();

  // ── Pass 1: build structures using fixture IDs directly as runtime IDs ─────
  for (const [alias, budgetSnap] of Object.entries(fixture.budgets)) {
    const budgetId = runtimeBudgetId(alias);
    idMap.budgetIdToAlias.set(budgetId, alias);
    idMap.aliasToBudgetId.set(alias, budgetId);

    const accounts = new Map<string, RuntimeAccount>();
    const accountsByName = new Map<string, RuntimeAccount>();

    for (const [accountName, acctSnap] of Object.entries(budgetSnap.accounts)) {
      const accountId = runtimeAccountId(alias, accountName);
      const txMap = new Map<string, RuntimeTransaction>();

      for (const txSnap of acctSnap.transactions) {
        if (seenIds.has(txSnap.id)) {
          throw new Error(`Duplicate transaction id "${txSnap.id}" in ${alias}.${accountName}`);
        }
        seenIds.add(txSnap.id);
        idMap.placeholderToTxId.set(txSnap.id, txSnap.id);
        idMap.txIdToPlaceholder.set(txSnap.id, txSnap.id);

        const subs: RuntimeSubTransaction[] = [];
        for (const sub of txSnap.subs) {
          if (seenIds.has(sub.id)) {
            throw new Error(`Duplicate transaction id "${sub.id}" in ${alias}.${accountName}`);
          }
          seenIds.add(sub.id);
          idMap.placeholderToTxId.set(sub.id, sub.id);
          idMap.txIdToPlaceholder.set(sub.id, sub.id);
          subs.push({
            id: sub.id,
            date: sub.date,
            amount: sub.amount,
            payee_name: sub.payee_name,
            notes: sub.notes,
            category: sub.category,
            cleared: sub.cleared,
            imported_id: sub.imported_id, // rewritten in pass 2
          });
        }

        const runtimeTx: RuntimeTransaction = {
          id: txSnap.id,
          date: txSnap.date,
          amount: txSnap.amount,
          payee_name: txSnap.payee_name,
          notes: txSnap.notes,
          category: txSnap.category,
          cleared: txSnap.cleared ?? undefined,
          imported_id: txSnap.imported_id, // rewritten in pass 2
          is_parent: subs.length > 0 ? true : undefined,
          subtransactions: subs.length > 0 ? subs : undefined,
        };
        txMap.set(txSnap.id, runtimeTx);
      }

      const account: RuntimeAccount = {
        id: accountId,
        name: accountName,
        offbudget: acctSnap.offbudget ?? false,
        closed: acctSnap.closed ?? false,
        transactions: txMap,
      };
      accounts.set(accountId, account);
      accountsByName.set(accountName, account);
    }

    env.budgets.set(alias, { id: budgetId, alias, accounts, accountsByName });
  }

  // ── Pass 2: rewrite imported_id using the now-complete IdMap ──────────────
  for (const budget of env.budgets.values()) {
    for (const account of budget.accounts.values()) {
      for (const tx of account.transactions.values()) {
        tx.imported_id = rewriteImportedIdFixtureToRuntime(
          tx.imported_id ?? null,
          idMap
        );
        if (tx.subtransactions) {
          for (const sub of tx.subtransactions) {
            sub.imported_id = rewriteImportedIdFixtureToRuntime(
              sub.imported_id ?? null,
              idMap
            );
          }
        }
      }
    }
  }

  return { env, idMap };
}

/**
 * Rewrite "ABMirror:<alias>:<TX-N>" → "ABMirror:<budgetId>:<runtimeUUID>".
 * Also handles split default compound IDs: "ABMirror:<alias>:<TX-N>::default::<acctId>"
 * → "ABMirror:<budgetId>:<runtimeUUID>::default::<acctId>".
 * Non-ABMirror values and references to unknown placeholders are left as-is.
 */
function rewriteImportedIdFixtureToRuntime(
  importedId: string | null,
  idMap: IdMap
): string | null {
  if (!isABMirrorId(importedId)) return importedId;
  const parsed = parseImportedId(importedId as string);
  if (!parsed) return importedId;
  const runtimeBId = idMap.aliasToBudgetId.get(parsed.budgetId);
  if (!runtimeBId) return importedId; // unknown alias — leave as-is

  // Direct lookup (no ::default:: suffix)
  const runtimeTxId = idMap.placeholderToTxId.get(parsed.txId);
  if (runtimeTxId) return formatImportedId(runtimeBId, runtimeTxId);

  // Handle split default compound IDs: "<placeholder>::default::<acctId>"
  const defaultIdx = parsed.txId.indexOf("::default::");
  if (defaultIdx !== -1) {
    const basePlaceholder = parsed.txId.slice(0, defaultIdx);
    const suffix = parsed.txId.slice(defaultIdx);
    const baseRuntimeId = idMap.placeholderToTxId.get(basePlaceholder);
    if (baseRuntimeId) return formatImportedId(runtimeBId, baseRuntimeId + suffix);
  }

  // If the alias is known but the tx placeholder isn't (stale/dangling reference),
  // still rewrite the budget ID so rootTxIndex lookups use the correct key.
  return formatImportedId(runtimeBId, parsed.txId);
}

// ─── exportRuntimeToFixture ───────────────────────────────────────────────────

/**
 * Snapshot a RuntimeEnv back to a FixtureSnapshot.
 *
 * Known transactions (in idMap from import) keep their original fixture IDs.
 * New engine-created transactions are assigned fresh TX-N IDs starting from
 * max(existing N) + 1, in canonical sort order.
 */
export function exportRuntimeToFixture(
  env: RuntimeEnv,
  idMap: IdMap
): FixtureSnapshot {
  // Build alias lookup from the env (deterministic: "budget-${alias}")
  const budgetIdToAlias = new Map<string, string>(idMap.budgetIdToAlias);
  for (const [alias, budget] of env.budgets) {
    if (!budgetIdToAlias.has(budget.id)) {
      budgetIdToAlias.set(budget.id, alias);
    }
  }

  type TxWithCtx = {
    budgetAlias: string;
    accountName: string;
    tx: RuntimeTransaction;
  };

  // Collect all visible top-level transactions with context
  const allTxs: TxWithCtx[] = [];
  for (const [alias, budget] of [...env.budgets.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    for (const account of [...budget.accounts.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      for (const tx of account.transactions.values()) {
        if (tx.tombstone || tx.is_child) continue;
        allTxs.push({ budgetAlias: alias, accountName: account.name, tx });
      }
    }
  }

  // Sort globally: (budgetAlias, accountName, date, notes, payee_name), then amount
  allTxs.sort((a, b) => {
    const ka = `${a.budgetAlias}\0${a.accountName}\0${a.tx.date}\0${a.tx.notes ?? ""}\0${a.tx.payee_name ?? ""}`;
    const kb = `${b.budgetAlias}\0${b.accountName}\0${b.tx.date}\0${b.tx.notes ?? ""}\0${b.tx.payee_name ?? ""}`;
    if (ka !== kb) return ka.localeCompare(kb);
    return a.tx.amount - b.tx.amount;
  });

  // Build txToPlaceholder: preserve original IDs for known txs, assign fresh for new
  const txToPlaceholder = new Map<string, string>();

  // Find max existing TX-N number so fresh IDs don't collide
  let maxN = 0;
  for (const placeholder of idMap.txIdToPlaceholder.values()) {
    const m = placeholder.match(/^TX-(\d+)$/);
    if (m) maxN = Math.max(maxN, parseInt(m[1]!, 10));
  }

  // First pass: populate known txs from IdMap
  for (const { tx } of allTxs) {
    const known = idMap.txIdToPlaceholder.get(tx.id);
    if (known) {
      txToPlaceholder.set(tx.id, known);
      if (tx.subtransactions) {
        for (const sub of tx.subtransactions) {
          const knownSub = idMap.txIdToPlaceholder.get(sub.id);
          if (knownSub) txToPlaceholder.set(sub.id, knownSub);
        }
      }
    }
  }

  // Second pass: assign fresh IDs to new (engine-created) txs
  for (const { tx } of allTxs) {
    if (!txToPlaceholder.has(tx.id)) {
      maxN++;
      const placeholder = `TX-${maxN}`;
      txToPlaceholder.set(tx.id, placeholder);
      if (tx.subtransactions) {
        let subN = 0;
        for (const sub of tx.subtransactions) {
          if (!txToPlaceholder.has(sub.id)) {
            subN++;
            txToPlaceholder.set(sub.id, `${placeholder}-SUB-${subN}`);
          }
        }
      }
    }
  }

  // Build FixtureSnapshot, preserving account metadata and sort order
  const budgets: Record<string, BudgetSnapshot> = {};
  for (const [alias, budget] of [...env.budgets.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const accounts: Record<string, AccountSnapshot> = {};
    for (const account of [...budget.accounts.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const visibleTxs = allTxs
        .filter(
          ({ budgetAlias, accountName }) =>
            budgetAlias === alias && accountName === account.name
        )
        .map(({ tx }) => tx);

      const acctSnap: AccountSnapshot = {
        transactions: visibleTxs.map((tx) =>
          txToTxSnapshot(tx, txToPlaceholder, budgetIdToAlias)
        ),
      };
      if (account.offbudget) acctSnap.offbudget = true;
      if (account.closed) acctSnap.closed = true;
      accounts[account.name] = acctSnap;
    }
    budgets[alias] = { accounts };
  }

  return { budgets };
}

function txToTxSnapshot(
  tx: RuntimeTransaction,
  txToPlaceholder: Map<string, string>,
  budgetIdToAlias: Map<string, string>
): TxSnapshot {
  return {
    id: txToPlaceholder.get(tx.id) ?? tx.id,
    date: tx.date,
    amount: tx.amount,
    payee_name: tx.payee_name ?? null,
    notes: tx.notes ?? null,
    category: tx.category ?? null,
    cleared: tx.cleared ?? null,
    imported_id: rewriteImportedIdRuntimeToFixture(
      tx.imported_id ?? null,
      txToPlaceholder,
      budgetIdToAlias
    ),
    subs: (tx.subtransactions ?? []).map((sub) =>
      subToSubSnapshot(sub, txToPlaceholder, budgetIdToAlias)
    ),
  };
}

function subToSubSnapshot(
  sub: RuntimeSubTransaction,
  txToPlaceholder: Map<string, string>,
  budgetIdToAlias: Map<string, string>
): SubSnapshot {
  return {
    id: txToPlaceholder.get(sub.id) ?? sub.id,
    date: sub.date,
    amount: sub.amount,
    payee_name: sub.payee_name ?? null,
    notes: sub.notes ?? null,
    category: sub.category ?? null,
    cleared: sub.cleared ?? null,
    imported_id: rewriteImportedIdRuntimeToFixture(
      sub.imported_id ?? null,
      txToPlaceholder,
      budgetIdToAlias
    ),
  };
}

/**
 * Rewrite "ABMirror:<budgetId>:<runtimeUUID>" → "ABMirror:<alias>:<TX-N>".
 * Also handles split default compound IDs: "ABMirror:<budgetId>:<runtimeUUID>::default::<acctId>"
 * → "ABMirror:<alias>:<TX-N>::default::<acctId>".
 * Leaves non-ABMirror values and unknown references as-is.
 */
function rewriteImportedIdRuntimeToFixture(
  importedId: string | null,
  txToPlaceholder: Map<string, string>,
  budgetIdToAlias: Map<string, string>
): string | null {
  if (!isABMirrorId(importedId)) return importedId;
  const parsed = parseImportedId(importedId as string);
  if (!parsed) return importedId;
  const alias = budgetIdToAlias.get(parsed.budgetId);
  if (!alias) return importedId;

  // Direct lookup (no ::default:: suffix)
  const placeholder = txToPlaceholder.get(parsed.txId);
  if (placeholder) return formatImportedId(alias, placeholder);

  // Handle split default compound IDs: "<runtimeUUID>::default::<acctId>"
  const defaultIdx = parsed.txId.indexOf("::default::");
  if (defaultIdx !== -1) {
    const baseTxId = parsed.txId.slice(0, defaultIdx);
    const suffix = parsed.txId.slice(defaultIdx);
    const basePlaceholder = txToPlaceholder.get(baseTxId);
    if (basePlaceholder) return formatImportedId(alias, basePlaceholder + suffix);
  }

  // Alias is known but tx ID is unknown (e.g. stale/ghost reference): rewrite
  // the budget ID to alias form so the roundtrip is stable for before.yaml files.
  return formatImportedId(alias, parsed.txId);
}
