/**
 * Common sync engine: rsync-like flow where engines implement SyncEngine
 * and the library handles read, filter, diff, apply, delete.
 */
import * as actual from "@actual-app/api";
import { selectAccounts, selectTransactions } from "../selector/index";
import { resolveAccountsSpec } from "../util/account-resolver";
import type { BudgetManager } from "../client/budget-manager";
import type { ActualTransaction, NewTransaction } from "../selector/types";
import type { AccountsSpec } from "../config/schema";
import { isABMirrorId, parseImportedId } from "../util/imported-id";
import {
  indexExistingMirrored,
  computeDiff,
  applyDeletes,
  type SyncDiff,
} from "./sync-helpers";
import type { GlobalTxIndex, RootTxIndex } from "./global-tx-index";
import { getRootTxId } from "../util/imported-id";

export interface EngineOpts {
  sourceBudgetAlias: string;
  sourceBudgetId: string;
  sourceAccountsSpec: AccountsSpec;
  requiredTags?: string[];
  destBudgetAlias: string;
  destBudgetId: string;
  destAccountIds: string[];
  lookbackDays: number;
  dryRun: boolean;
  reporter?: import("../notify/reporter").RunReporter;
  stepIndex?: number;
  /** When true, log desired/existing keys and add/delete details for debugging non-convergence */
  debugSync?: boolean;
  stepType: "split" | "mirror";
  /** Mirror only: when false, never delete (even if source is gone). Split always deletes. */
  deleteEnabled?: boolean;
  /** Split engine only: resolved tag entries with destination_account as ID */
  tagEntries?: Array<[string, { multiplier: number; destination_account: string }]>;
  /** Split only: when source spec is broad, exclude these account IDs from source scope */
  excludeAccountIds?: Set<string>;
  /** Split only: when set, txs matching no tag get this action (destination_account is resolved ID) */
  defaultAction?: { multiplier: number; destination_account: string };
  /**
   * Global pre-pass index of canonical tx locations. Used by mirror engine to skip
   * placing a tx where a copy from the same canonical origin already exists.
   */
  globalTxIndex?: GlobalTxIndex;
  /**
   * Pre-pass index of root (non-ABMirror) tx IDs per budget. Used in the delete filter:
   * a mirrored copy is only deleted if its canonical source tx no longer exists.
   */
  rootTxIndex?: RootTxIndex;
  /** When true, update payee_name/notes/category/cleared on existing copies (not just date/amount). */
  updateFields?: boolean;
  /** Max changes before aborting. 0 or undefined = unlimited. */
  maxChangesPerStep?: number;
}

export interface ProposeResult {
  desired: Map<string, { accountId: string; tx: NewTransaction }>;
  onWarn?: (code: string, detail: unknown) => void;
}

export interface SyncEngine {
  propose(sourceTxs: ActualTransaction[], opts: EngineOpts): ProposeResult;
  getDestBudgetId(opts: EngineOpts): string;
  getDestAccountIds(opts: EngineOpts): string[];
}

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function lookbackStart(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return formatLocalDate(d);
}

export async function runSyncEngine(
  engine: SyncEngine,
  opts: EngineOpts,
  manager: BudgetManager
): Promise<void> {
  const { sourceBudgetId, lookbackDays, dryRun, reporter } = opts;
  const startDate = lookbackStart(lookbackDays);
  const endDate = formatLocalDate(new Date());

  // --- Phase 1: Read source transactions ---
  await manager.open(opts.sourceBudgetAlias);

  const allSourceAccounts = (await actual.getAccounts()) as import("../selector/types").ActualAccount[];
  const srcResolved = resolveAccountsSpec(
    allSourceAccounts,
    opts.sourceAccountsSpec,
    opts.sourceBudgetAlias
  );
  if (!srcResolved.ok) {
    throw new Error(srcResolved.error);
  }

  const selectedAccounts = selectAccounts(
    allSourceAccounts,
    srcResolved.spec!,
    opts.excludeAccountIds
  );
  const selector = {
    accounts: opts.sourceAccountsSpec,
    requiredTags: opts.requiredTags,
  };

  const sourceTxFlat: ActualTransaction[] = [];
  for (const acct of selectedAccounts) {
    const txs = await actual.getTransactions(acct.id, startDate, endDate);
    sourceTxFlat.push(...(txs as ActualTransaction[]));
  }

  const filteredSourceTxs: ActualTransaction[] = [];
  for (const tx of selectTransactions(sourceTxFlat, selector)) {
    filteredSourceTxs.push(tx);
  }

  // --- Phase 2: Engine proposes desired state ---
  const result = engine.propose(filteredSourceTxs, opts);
  const { desired } = result;

  // --- Phase 3: Read existing from all dest accounts ---
  await manager.open(opts.destBudgetAlias);

  const existing = new Map<string, ActualTransaction>();
  for (const destId of opts.destAccountIds) {
    const destTxs = (await actual.getTransactions(
      destId,
      startDate,
      endDate
    )) as ActualTransaction[];
    const partial = indexExistingMirrored(destTxs);
    for (const [k, v] of partial) existing.set(k, v);
  }

  // --- Phase 4: Compute diff and apply ---
  const diff = computeDiff(desired, existing, { updateFields: opts.updateFields });

  if (opts.debugSync && (diff.toAdd.length > 0 || diff.toUpdate.length > 0 || diff.toDelete.length > 0)) {
    const stepLabel = opts.stepIndex !== undefined ? `step ${opts.stepIndex + 1}` : "step";
    const desiredKeys = [...desired.keys()].sort();
    const existingKeys = [...existing.keys()].sort();
    // eslint-disable-next-line no-console
    console.error(
      `[DEBUG_SYNC] ${stepLabel} (${opts.stepType} ${opts.sourceBudgetAlias}→${opts.destBudgetAlias}): ` +
        `desired keys (${desiredKeys.length})=${JSON.stringify(desiredKeys.slice(0, 10))}${desiredKeys.length > 10 ? "…" : ""} ` +
        `existing keys (${existingKeys.length})=${JSON.stringify(existingKeys.slice(0, 10))}${existingKeys.length > 10 ? "…" : ""}`
    );
    for (const { tx } of diff.toAdd) {
      // eslint-disable-next-line no-console
      console.error(`[DEBUG_SYNC]   toAdd: imported_id=${tx.imported_id ?? "null"} date=${tx.date} amount=${tx.amount ?? 0}`);
    }
    for (const tx of diff.toDelete) {
      // eslint-disable-next-line no-console
      console.error(
        `[DEBUG_SYNC]   toDelete candidate: id=${tx.id} imported_id=${tx.imported_id ?? "null"}`
      );
    }
  }

  // Delete a mirrored copy only when its canonical root transaction is gone.
  // rootTxIndex provides O(1) existence checks; without it, fall back to old
  // budget-match behaviour (same-budget mirrors never delete in that mode).
  // For split steps with multiple dest accounts: only delete from accounts we're
  // writing to this round, so we don't clobber another split step's output.
  const desiredAccountIds = new Set([...desired.values()].map((d) => d.accountId));
  const toDelete =
    opts.deleteEnabled !== false
      ? diff.toDelete.filter((tx) => {
          if (!isABMirrorId(tx.imported_id)) return false;
          const parsed = parseImportedId(tx.imported_id as string);
          if (!parsed) return false;

          if (opts.rootTxIndex) {
            const rootTxId = getRootTxId(parsed.txId);
            const rootExists = opts.rootTxIndex.get(parsed.budgetId)?.has(rootTxId) ?? false;
            if (rootExists) return false;
          } else {
            // Fallback: old behaviour
            if (opts.stepType === "mirror" && opts.sourceBudgetId === opts.destBudgetId) return false;
            if (parsed.budgetId !== sourceBudgetId) return false;
          }

          // Without rootTxIndex, restrict split deletes to accounts with active writes
          // to avoid cross-step interference. With rootTxIndex, source existence checks suffice.
          if (opts.stepType === "split" && !opts.rootTxIndex && !desiredAccountIds.has(tx.account)) return false;
          return true;
        })
      : [];
  if (reporter) {
    reporter.recordStep({
      type: opts.stepType,
      added: diff.toAdd.length,
      updated: diff.toUpdate.length,
      deleted: toDelete.length,
    });
  }

  const totalChanges = diff.toAdd.length + diff.toUpdate.length + toDelete.length;

  if (totalChanges > 50 && reporter) {
    reporter.warn("sync.highChangeCount", {
      stepIndex: opts.stepIndex ?? 0,
      total: totalChanges,
      added: diff.toAdd.length,
      updated: diff.toUpdate.length,
      deleted: toDelete.length,
    });
  }

  if (opts.maxChangesPerStep && totalChanges > opts.maxChangesPerStep) {
    throw new Error(
      `Circuit breaker: step would make ${totalChanges} changes ` +
      `(add=${diff.toAdd.length} update=${diff.toUpdate.length} delete=${toDelete.length}), ` +
      `limit is ${opts.maxChangesPerStep}. Use --max-changes 0 to disable.`
    );
  }

  if (dryRun) {
    console.log(
      `  [dry-run] would add=${diff.toAdd.length} update=${diff.toUpdate.length} delete=${toDelete.length}`
    );
    return;
  }

  for (const { accountId, tx } of diff.toAdd) {
    await actual.addTransactions(accountId, [tx]);
  }
  for (const { id, category, ...rest } of diff.toUpdate) {
    // Actual API doesn't accept null for category; use undefined to clear.
    const fields = { ...rest, ...(category !== undefined && { category: category ?? undefined }) };
    await actual.updateTransaction(id, fields);
  }
  await applyDeletes(toDelete);

  console.log(
    `  added=${diff.toAdd.length} updated=${diff.toUpdate.length} deleted=${toDelete.length}`
  );
}
