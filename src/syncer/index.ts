/**
 * Generic transaction mirror: copies transactions from a source budget+account(s)
 * to a destination budget+account, tracking them via imported_id so subsequent
 * runs only update date/amount (preserving any user edits to other fields).
 *
 * Uses the common sync engine under the hood.
 */
import { createMirrorEngine, buildMirrorOpts } from "../engines/mirror-engine";
import { runSyncEngine } from "../diff/sync-engine";
import { computeDiff } from "../diff/sync-helpers";
import { formatImportedId } from "../util/imported-id";
import type { MirrorStep } from "../config/schema";
import type { BudgetManager } from "../client/budget-manager";
import type { ActualTransaction, NewTransaction } from "../selector/types";

export interface SyncerOptions {
  step: MirrorStep;
  sourceBudgetId: string;
  lookbackDays: number;
  dryRun: boolean;
  reporter?: import("../notify/reporter").RunReporter;
}

/** @deprecated Use SyncDiff from diff/sync-helpers. Kept for backward compatibility. */
export interface SyncDiff {
  toAdd: NewTransaction[];
  toUpdate: Array<{ id: string; date: string; amount: number }>;
  toDelete: string[];
}

/**
 * Pure function: given matched source transactions and existing mirrored
 * destination transactions, compute what needs to be added, updated, or deleted.
 * Uses unified key sourceId:destAccountId.
 *
 * @deprecated Use computeDiff from diff/sync-helpers. Kept for backward compatibility.
 */
export function computeSyncDiff(
  matchedSourceTxs: ActualTransaction[],
  existingBySourceId: Map<string, ActualTransaction>,
  destAccount: string,
  sourceBudgetId: string,
  step: MirrorStep
): SyncDiff {
  const desired = new Map<string, { accountId: string; tx: NewTransaction }>();
  for (const sourceTx of matchedSourceTxs) {
    const amount = step.invert ? -sourceTx.amount : sourceTx.amount;
    const category =
      step.categoryMapping && sourceTx.category
        ? (step.categoryMapping[sourceTx.category] ?? undefined)
        : undefined;
    const key = `${sourceTx.id}:${destAccount}`;
    desired.set(key, {
      accountId: destAccount,
      tx: {
        date: sourceTx.date,
        amount,
        payee_name: sourceTx.payee_name ?? undefined,
        notes: sourceTx.notes ?? undefined,
        category,
        cleared: sourceTx.cleared,
        imported_id: formatImportedId(sourceBudgetId, sourceTx.id),
      },
    });
  }
  // Convert existing from legacy key (sourceId) to unified key (sourceId:destAccountId)
  const existingUnified = new Map<string, ActualTransaction>();
  for (const [sourceId, tx] of existingBySourceId) {
    existingUnified.set(`${sourceId}:${destAccount}`, tx);
  }
  const diff = computeDiff(desired, existingUnified);
  const toDelete = step.delete ? diff.toDelete.map((tx) => tx.id) : [];
  return {
    toAdd: diff.toAdd.map(({ tx }) => tx),
    toUpdate: diff.toUpdate,
    toDelete,
  };
}

export async function runSyncer(
  opts: SyncerOptions,
  manager: BudgetManager
): Promise<void> {
  const engine = createMirrorEngine(opts.step);
  const engineOpts = await buildMirrorOpts(
    opts.step,
    {
      lookbackDays: opts.lookbackDays,
      dryRun: opts.dryRun,
      reporter: opts.reporter,
    },
    manager
  );
  await runSyncEngine(engine, engineOpts, manager);
}
