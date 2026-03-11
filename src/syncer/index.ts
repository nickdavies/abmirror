/**
 * Generic transaction mirror: copies transactions from a source budget+account(s)
 * to a destination budget+account, tracking them via imported_id so subsequent
 * runs only update date/amount (preserving any user edits to other fields).
 */
import * as actual from "@actual-app/api";
import { formatImportedId, isABMirrorId, parseImportedId } from "../util/imported-id";
import { selectAccounts, selectTransactions } from "../selector/index";
import type { MirrorStep } from "../config/schema";
import type { BudgetManager } from "../client/budget-manager";
import type { ActualTransaction, NewTransaction } from "../selector/types";

export interface SyncerOptions {
  step: MirrorStep;
  sourceBudgetId: string;
  lookbackDays: number;
  dryRun: boolean;
}

export interface SyncDiff {
  toAdd: NewTransaction[];
  toUpdate: Array<{ id: string; date: string; amount: number }>;
  toDelete: string[]; // destination transaction IDs
}

/**
 * Pure function: given matched source transactions and existing mirrored
 * destination transactions, compute what needs to be added, updated, or deleted.
 */
export function computeSyncDiff(
  matchedSourceTxs: ActualTransaction[],
  existingBySourceId: Map<string, ActualTransaction>,
  destAccount: string,
  sourceBudgetId: string,
  step: MirrorStep
): SyncDiff {
  const sourceIdSet = new Set(matchedSourceTxs.map((t) => t.id));
  const toAdd: NewTransaction[] = [];
  const toUpdate: SyncDiff["toUpdate"] = [];
  const toDelete: string[] = [];

  for (const sourceTx of matchedSourceTxs) {
    const amount = step.invert ? -sourceTx.amount : sourceTx.amount;
    const importedId = formatImportedId(sourceBudgetId, sourceTx.id);
    const existing = existingBySourceId.get(sourceTx.id);

    if (!existing) {
      const category =
        step.categoryMapping && sourceTx.category
          ? (step.categoryMapping[sourceTx.category] ?? undefined)
          : undefined;

      toAdd.push({
        date: sourceTx.date,
        amount,
        payee_name: sourceTx.payee_name ?? undefined,
        notes: sourceTx.notes ?? undefined,
        category,
        cleared: sourceTx.cleared,
        imported_id: importedId,
      });
    } else if (existing.date !== sourceTx.date || existing.amount !== amount) {
      toUpdate.push({ id: existing.id, date: sourceTx.date, amount });
    }
  }

  if (step.delete) {
    for (const [sourceId, destTx] of existingBySourceId) {
      if (!sourceIdSet.has(sourceId)) {
        toDelete.push(destTx.id);
      }
    }
  }

  return { toAdd, toUpdate, toDelete };
}

/** Returns "YYYY-MM-DD" for the date N days ago. */
function lookbackStart(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function runSyncer(
  opts: SyncerOptions,
  manager: BudgetManager
): Promise<void> {
  const { step, sourceBudgetId, lookbackDays, dryRun } = opts;
  const startDate = lookbackStart(lookbackDays);
  const endDate = new Date().toISOString().slice(0, 10);

  // --- Phase 1: Read source transactions ---
  await manager.open(step.source.budget);

  const allSourceAccounts = await actual.getAccounts();
  const selectedAccounts = selectAccounts(
    allSourceAccounts as import("../selector/types").ActualAccount[],
    step.source.accounts
  );

  const selector = {
    accounts: step.source.accounts,
    requiredTags: step.source.requiredTags,
  };

  const sourceTxFlat: ActualTransaction[] = [];
  for (const acct of selectedAccounts) {
    const txs = await actual.getTransactions(acct.id, startDate, endDate);
    sourceTxFlat.push(...(txs as ActualTransaction[]));
  }

  // Filter by selector; skip ABMirror-stamped transactions unless copyMirrored
  const matchedSourceTxs: ActualTransaction[] = [];
  for (const tx of selectTransactions(sourceTxFlat, selector)) {
    if (!step.copyMirrored && isABMirrorId(tx.imported_id)) continue;
    matchedSourceTxs.push(tx);
  }

  // --- Phase 2: Read existing mirrored transactions from destination ---
  // Opening the destination budget closes source (if different)
  await manager.open(step.destination.budget);

  const destAccount = step.destination.account;
  const destTxs = (await actual.getTransactions(
    destAccount,
    startDate,
    endDate
  )) as ActualTransaction[];

  // Index existing mirrored transactions by their source transaction ID
  const existingBySourceId = new Map<string, ActualTransaction>();
  for (const tx of destTxs) {
    if (!isABMirrorId(tx.imported_id)) continue;
    const parsed = parseImportedId(tx.imported_id as string);
    if (parsed?.budgetId === sourceBudgetId) {
      existingBySourceId.set(parsed.txId, tx);
    }
  }

  // --- Phase 3: Compute and apply diff ---
  const diff = computeSyncDiff(
    matchedSourceTxs,
    existingBySourceId,
    destAccount,
    sourceBudgetId,
    step
  );

  if (dryRun) {
    console.log(
      `  [dry-run] would add=${diff.toAdd.length} update=${diff.toUpdate.length} delete=${diff.toDelete.length}`
    );
    return;
  }

  if (diff.toAdd.length > 0) {
    await actual.addTransactions(destAccount, diff.toAdd);
  }
  for (const { id, date, amount } of diff.toUpdate) {
    await actual.updateTransaction(id, { date, amount });
  }
  for (const id of diff.toDelete) {
    await actual.deleteTransaction(id);
  }

  console.log(
    `  added=${diff.toAdd.length} updated=${diff.toUpdate.length} deleted=${diff.toDelete.length}`
  );
}
