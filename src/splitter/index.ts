/**
 * Tag-based transaction splitter: within a single budget, scans transactions
 * for action hashtags and creates transformed copies in a destination account.
 *
 * Uses the common sync engine under the hood.
 */
import { createSplitEngine, buildSplitOpts } from "../engines/split-engine";
import { runSyncEngine } from "../diff/sync-engine";
import type { SplitStep, TagAction } from "../config/schema";
import type { BudgetManager } from "../client/budget-manager";
import type { ActualTransaction, NewTransaction } from "../selector/types";
import { parseTags } from "../util/tags";
import { formatImportedId, isABMirrorId } from "../util/imported-id";
import { selectTransactions } from "../selector/index";
import { computeDiff } from "../diff/sync-helpers";

export interface SplitterOptions {
  step: SplitStep;
  budgetId: string;
  lookbackDays: number;
  dryRun: boolean;
  reporter?: import("../notify/reporter").RunReporter;
  stepIndex?: number;
}

export interface SplitDiff {
  toAdd: Array<{ accountId: string; tx: NewTransaction }>;
  toUpdate: Array<{ id: string; date: string; amount: number }>;
  toDelete?: ActualTransaction[];
}

export type OnWarn = (code: "splitter.multiTagMatch" | "splitter.scopeMatchNoActionTag", detail: unknown) => void;

/**
 * Pure function: matches source transactions against action tags and
 * computes what to add, update, or delete in the destination account(s).
 *
 * @deprecated Use createSplitEngine + propose + computeDiff. Kept for backward compatibility.
 */
export function computeSplitDiff(
  sourceTxs: ActualTransaction[],
  selector: { accounts: import("../config/schema").AccountsSpec; requiredTags?: string[] },
  tagEntries: Array<[string, TagAction]>,
  existingBySourceId: Map<string, ActualTransaction>,
  budgetId: string,
  opts: { splitMirrored?: boolean; onWarn?: OnWarn; stepIndex?: number } = {}
): SplitDiff {
  const { splitMirrored = false, onWarn, stepIndex = 0 } = opts;
  const desired = new Map<string, { accountId: string; tx: NewTransaction }>();
  let scopeMatchNoActionTagCount = 0;

  for (const tx of selectTransactions(sourceTxs, selector)) {
    if (!splitMirrored && isABMirrorId(tx.imported_id)) continue;

    const { tags: txTags } = parseTags(tx.notes);
    const matchingTags = tagEntries.filter(([tag]) =>
      txTags.includes(tag.toLowerCase())
    );

    if (matchingTags.length === 0) {
      scopeMatchNoActionTagCount++;
      continue;
    }

    if (matchingTags.length > 1) {
      if (onWarn) {
        onWarn("splitter.multiTagMatch", {
          txId: tx.id,
          payee: tx.payee_name ?? "?",
          date: tx.date,
          matchingTags: matchingTags.map(([t]) => t),
        });
      }
      continue;
    }

    const [, action] = matchingTags[0]!;
    const amount = Math.round(tx.amount * action.multiplier);
    const key = `${tx.id}:${action.destination_account}`;
    desired.set(key, {
      accountId: action.destination_account,
      tx: {
        date: tx.date,
        amount,
        payee_name: tx.payee_name ?? undefined,
        notes: tx.notes ?? undefined,
        category: tx.category ?? undefined,
        cleared: tx.cleared,
        imported_id: formatImportedId(budgetId, tx.id),
      },
    });
  }

  if (scopeMatchNoActionTagCount > 0 && onWarn) {
    onWarn("splitter.scopeMatchNoActionTag", { stepIndex, count: scopeMatchNoActionTagCount });
  }

  const diff = computeDiff(desired, existingBySourceId);
  return {
    toAdd: diff.toAdd,
    toUpdate: diff.toUpdate,
    toDelete: diff.toDelete,
  };
}

export async function runSplitter(
  opts: SplitterOptions,
  manager: BudgetManager
): Promise<void> {
  const engine = createSplitEngine(opts.step);
  const engineOpts = await buildSplitOpts(
    opts.step,
    {
      lookbackDays: opts.lookbackDays,
      dryRun: opts.dryRun,
      reporter: opts.reporter,
      stepIndex: opts.stepIndex,
    },
    manager
  );
  await runSyncEngine(engine, engineOpts, manager);
}
