/**
 * Shared sync helpers used by runSyncEngine.
 * - indexExistingMirrored: index dest txs by sourceId:destAccountId
 * - computeDiff: derive toAdd, toUpdate, toDelete from desired vs existing
 * - applyDeletes: re-verify before delete (defense in depth)
 */
import * as actual from "@actual-app/api";
import { isABMirrorId, parseImportedId } from "../util/imported-id";
import type { ActualTransaction, NewTransaction } from "../selector/types";

/** Index all ABMirror transactions by `parsed.txId:account` and `tx.id:account`. */
export function indexExistingMirrored(
  destTxs: ActualTransaction[]
): Map<string, ActualTransaction> {
  const map = new Map<string, ActualTransaction>();
  for (const tx of destTxs) {
    if (!isABMirrorId(tx.imported_id)) continue;
    const parsed = parseImportedId(tx.imported_id as string);
    if (!parsed) continue;
    map.set(`${parsed.txId}:${tx.account}`, tx);
    // Also index by tx.id so round-trip from mirror output matches
    map.set(`${tx.id}:${tx.account}`, tx);
  }
  return map;
}

export interface TransactionUpdate {
  id: string;
  date: string;
  amount: number;
  payee?: string | null;
  notes?: string;
  category?: string | null;
  cleared?: boolean;
}

export interface SyncDiff {
  toAdd: Array<{ accountId: string; tx: NewTransaction }>;
  toUpdate: TransactionUpdate[];
  toDelete: ActualTransaction[];
}

export interface DiffOptions {
  /** When true, compare and sync payee/notes/category/cleared (not just date/amount). */
  updateFields?: boolean;
}

/** Normalize null/undefined to a comparable value for field comparison. */
function strEq(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "") === (b ?? "");
}

export function computeDiff(
  desired: Map<string, { accountId: string; tx: NewTransaction }>,
  existing: Map<string, ActualTransaction>,
  opts?: DiffOptions
): SyncDiff {
  const toAdd: SyncDiff["toAdd"] = [];
  const toUpdate: SyncDiff["toUpdate"] = [];
  const toDelete: SyncDiff["toDelete"] = [];
  /** Existing tx ids already matched by a desired key (same tx can be indexed under multiple keys). */
  const matchedExistingIds = new Set<string>();

  for (const [key, { accountId, tx }] of desired) {
    const existingTx = existing.get(key);
    const amount = tx.amount ?? 0;
    if (!existingTx) {
      toAdd.push({ accountId, tx });
    } else {
      matchedExistingIds.add(existingTx.id);

      const dateChanged = existingTx.date !== tx.date;
      const amountChanged = existingTx.amount !== amount;

      if (opts?.updateFields) {
        const payeeChanged = (existingTx.payee ?? null) !== (tx.payee ?? null);
        const notesChanged = !strEq(existingTx.notes, tx.notes);
        const categoryChanged = (existingTx.category ?? null) !== (tx.category ?? null);
        const clearedChanged = (existingTx.cleared ?? false) !== (tx.cleared ?? false);

        if (dateChanged || amountChanged || payeeChanged || notesChanged || categoryChanged || clearedChanged) {
          const update: TransactionUpdate = { id: existingTx.id, date: tx.date, amount };
          if (payeeChanged) update.payee = tx.payee ?? null;
          if (notesChanged) update.notes = tx.notes ?? "";
          if (categoryChanged) update.category = tx.category ?? null;
          if (clearedChanged) update.cleared = tx.cleared ?? false;
          toUpdate.push(update);
        }
      } else {
        if (dateChanged || amountChanged) {
          toUpdate.push({ id: existingTx.id, date: tx.date, amount });
        }
      }
    }
  }
  const seenDeleteIds = new Set<string>();
  for (const [key, tx] of existing) {
    if (!desired.has(key) && !matchedExistingIds.has(tx.id) && !seenDeleteIds.has(tx.id)) {
      seenDeleteIds.add(tx.id);
      toDelete.push(tx);
    }
  }
  return { toAdd, toUpdate, toDelete };
}

export async function applyDeletes(toDelete: ActualTransaction[]): Promise<void> {
  for (const tx of toDelete) {
    if (!isABMirrorId(tx.imported_id)) {
      throw new Error(
        `Refusing to delete transaction ${tx.id}: not an ABMirror transaction (imported_id=${tx.imported_id ?? "null"})`
      );
    }
    await actual.deleteTransaction(tx.id);
  }
}
