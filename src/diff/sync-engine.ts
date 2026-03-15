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
import {
  indexExistingMirrored,
  computeDiff,
  applyDeletes,
  type SyncDiff,
} from "./sync-helpers";

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
  stepType: "split" | "mirror";
  /** Mirror only: when false, never delete (even if source is gone). Split always deletes. */
  deleteEnabled?: boolean;
  /** Split engine only: resolved tag entries with destination_account as ID */
  tagEntries?: Array<[string, { multiplier: number; destination_account: string }]>;
  /** Mirror only: budget IDs to index for cross-budget round-trip (e.g. beta→alpha via gamma) */
  indexBudgetIds?: string[];
  /** Split only: when source spec is broad, exclude these account IDs from source scope */
  excludeAccountIds?: Set<string>;
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

function lookbackStart(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function runSyncEngine(
  engine: SyncEngine,
  opts: EngineOpts,
  manager: BudgetManager
): Promise<void> {
  const { sourceBudgetId, lookbackDays, dryRun, reporter } = opts;
  const startDate = lookbackStart(lookbackDays);
  const endDate = new Date().toISOString().slice(0, 10);

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
    const partial = indexExistingMirrored(
      destTxs,
      sourceBudgetId,
      opts.destBudgetId,
      opts.indexBudgetIds
    );
    for (const [k, v] of partial) existing.set(k, v);
  }

  // --- Phase 4: Compute diff and apply ---
  const diff = computeDiff(desired, existing);

  const toDelete = opts.deleteEnabled !== false ? diff.toDelete : [];
  if (reporter) {
    reporter.recordStep({
      type: opts.stepType,
      added: diff.toAdd.length,
      updated: diff.toUpdate.length,
      deleted: toDelete.length,
    });
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
  for (const { id, date, amount } of diff.toUpdate) {
    await actual.updateTransaction(id, { date, amount });
  }
  await applyDeletes(toDelete, sourceBudgetId);

  console.log(
    `  added=${diff.toAdd.length} updated=${diff.toUpdate.length} deleted=${toDelete.length}`
  );
}
