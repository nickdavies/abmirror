/**
 * Fixture snapshot types and import/export helpers for YAML-based integration tests.
 *
 * On-disk format uses stable placeholder IDs ("TX-1", "TX-2", "TX-3-SUB-1", etc.) and
 * budget aliases (not UUIDs) in imported_id values, making fixtures reproducible across
 * runs and between the in-memory test harness and localdev/snapshot.ts.
 *
 * ID assignment algorithm (both export paths use the same rules):
 *  1. Sort all visible top-level transactions globally by
 *     (budgetAlias, accountName, date, notes ?? '', payee_name ?? ''), then by amount.
 *  2. Assign TX-1, TX-2, ... in that order.
 *  3. Within each parent, assign subs as TX-N-SUB-1, TX-N-SUB-2, ...
 *  4. Rewrite imported_id values: "ABMirror:<budgetId>:<txUuid>" →
 *     "ABMirror:<alias>:<TX-N>" using the maps built in step 2–3.
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

// ─── IdMap ────────────────────────────────────────────────────────────────────

/**
 * Bidirectional mapping between runtime UUIDs and fixture placeholder IDs.
 * Budget alias ↔ runtime budget ID mappings are also stored here.
 */
export type IdMap = {
  /** runtime UUID → "TX-N" or "TX-N-SUB-M" */
  txIdToPlaceholder: Map<string, string>;
  /** "TX-N" or "TX-N-SUB-M" → runtime UUID */
  placeholderToTxId: Map<string, string>;
  /** runtime budget ID (e.g. "budget-src") → alias ("src") */
  budgetIdToAlias: Map<string, string>;
  /** alias → runtime budget ID */
  aliasToBudgetId: Map<string, string>;
};

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
 * mappings into exportRuntimeToFixture.
 *
 * Transaction IDs are assigned sequentially ("test-tx-1", "test-tx-2", …).
 * Pass 1 builds all structures; Pass 2 rewrites imported_id values.
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
  let txCounter = 0;

  // ── Pass 1: allocate all runtime IDs and build structures ──────────────────
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
        txCounter++;
        const runtimeId = `test-tx-${txCounter}`;
        idMap.placeholderToTxId.set(txSnap.id, runtimeId);
        idMap.txIdToPlaceholder.set(runtimeId, txSnap.id);

        const subs: RuntimeSubTransaction[] = [];
        for (const sub of txSnap.subs) {
          txCounter++;
          const subRuntimeId = `test-tx-${txCounter}`;
          idMap.placeholderToTxId.set(sub.id, subRuntimeId);
          idMap.txIdToPlaceholder.set(subRuntimeId, sub.id);
          subs.push({
            id: subRuntimeId,
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
          id: runtimeId,
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
        txMap.set(runtimeId, runtimeTx);
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
  const runtimeTxId = idMap.placeholderToTxId.get(parsed.txId);
  if (!runtimeBId || !runtimeTxId) return importedId;
  return formatImportedId(runtimeBId, runtimeTxId);
}

// ─── exportRuntimeToFixture ───────────────────────────────────────────────────

/**
 * Snapshot a RuntimeEnv back to a FixtureSnapshot using fresh placeholder IDs.
 *
 * The idMap is used only for its budget alias mappings. Transaction placeholder
 * IDs are always assigned fresh based on the global sort order so that the
 * output matches what localdev/snapshot.ts would produce for the same state.
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

  // Assign TX-N and TX-N-SUB-M placeholders
  const txToPlaceholder = new Map<string, string>();
  let txN = 0;
  for (const { tx } of allTxs) {
    txN++;
    const placeholder = `TX-${txN}`;
    txToPlaceholder.set(tx.id, placeholder);
    if (tx.subtransactions) {
      let subN = 0;
      for (const sub of tx.subtransactions) {
        subN++;
        txToPlaceholder.set(sub.id, `${placeholder}-SUB-${subN}`);
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
  const placeholder = txToPlaceholder.get(parsed.txId);
  if (!alias || !placeholder) return importedId;
  return formatImportedId(alias, placeholder);
}
