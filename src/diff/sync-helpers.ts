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

export interface SyncDiff {
  toAdd: Array<{ accountId: string; tx: NewTransaction }>;
  toUpdate: Array<{ id: string; date: string; amount: number }>;
  toDelete: ActualTransaction[];
}

export function computeDiff(
  desired: Map<string, { accountId: string; tx: NewTransaction }>,
  existing: Map<string, ActualTransaction>
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
      if (existingTx.date !== tx.date || existingTx.amount !== amount) {
        toUpdate.push({ id: existingTx.id, date: tx.date, amount });
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
