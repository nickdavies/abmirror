/**
 * Tag-based transaction splitter: within a single budget, scans transactions
 * for action hashtags and creates transformed copies in a destination account.
 *
 * Flow:
 *   1. Source selector filters by accounts + requiredTags (scope guard).
 *   2. Action tags (#50/50, #0/100, etc.) determine the transform.
 *   3. When exactly one tag matches, apply it. When multiple match, skip (always exclusive).
 *   4. Existing mirrored copies are updated (date + amount) if changed.
 */
import * as actual from "@actual-app/api";
import { formatImportedId, isABMirrorId, parseImportedId } from "../util/imported-id";
import { parseTags } from "../util/tags";
import { selectAccounts, selectTransactions } from "../selector/index";
import { resolveAccountsSpec, resolveAccountId } from "../util/account-resolver";
import type { SplitStep, TagAction } from "../config/schema";
import type { BudgetManager } from "../client/budget-manager";
import type { ActualTransaction, NewTransaction } from "../selector/types";

export interface SplitterOptions {
  step: SplitStep;
  budgetId: string;
  lookbackDays: number;
  dryRun: boolean;
  /** Optional reporter for warnings and step results. */
  reporter?: import("../notify/reporter").RunReporter;
  /** Step index (0-based) for warning context. */
  stepIndex?: number;
}

export interface SplitDiff {
  toAdd: Array<{ accountId: string; tx: NewTransaction }>;
  toUpdate: Array<{ id: string; date: string; amount: number }>;
}

export type OnWarn = (code: "splitter.multiTagMatch" | "splitter.scopeMatchNoActionTag", detail: unknown) => void;

/**
 * Pure function: matches source transactions against action tags and
 * computes what to add or update in the destination account(s).
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
  const toAdd: SplitDiff["toAdd"] = [];
  const toUpdate: SplitDiff["toUpdate"] = [];
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
        const matchingTagNames = matchingTags.map(([t]) => t);
        onWarn("splitter.multiTagMatch", {
          txId: tx.id,
          payee: tx.payee_name ?? "?",
          date: tx.date,
          matchingTags: matchingTagNames,
        });
      }
      continue;
    }

    const [tag, action] = matchingTags[0]!;
    const amount = Math.round(tx.amount * action.multiplier);
    const importedId = formatImportedId(budgetId, tx.id);
    const key = `${tx.id}:${action.destination_account}`;
    const existing = existingBySourceId.get(key);

    if (!existing) {
      toAdd.push({
        accountId: action.destination_account,
        tx: {
          date: tx.date,
          amount,
          payee_name: tx.payee_name ?? undefined,
          notes: tx.notes ?? undefined,
          // Same budget so categories are 1:1
          category: tx.category ?? undefined,
          cleared: tx.cleared,
          imported_id: importedId,
        },
      });
    } else if (existing.date !== tx.date || existing.amount !== amount) {
      toUpdate.push({ id: existing.id, date: tx.date, amount });
    }
  }

  if (scopeMatchNoActionTagCount > 0 && onWarn) {
    onWarn("splitter.scopeMatchNoActionTag", {
      stepIndex,
      count: scopeMatchNoActionTagCount,
    });
  }

  return { toAdd, toUpdate };
}

/** Returns "YYYY-MM-DD" for the date N days ago. */
function lookbackStart(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function runSplitter(
  opts: SplitterOptions,
  manager: BudgetManager
): Promise<void> {
  const { step, budgetId, lookbackDays, dryRun, reporter, stepIndex = 0 } = opts;
  const startDate = lookbackStart(lookbackDays);
  const endDate = new Date().toISOString().slice(0, 10);

  // Tags evaluated in config-definition order (Object.entries preserves insertion order)
  const tagEntries = Object.entries(step.tags) as Array<[string, TagAction]>;

  await manager.open(step.budget);

  const allAccounts = (await actual.getAccounts()) as import("../selector/types").ActualAccount[];
  const srcResolved = resolveAccountsSpec(
    allAccounts,
    step.source.accounts,
    step.budget
  );
  if (!srcResolved.ok) {
    throw new Error(srcResolved.error);
  }

  // Resolve each tag's destination_account (name -> ID)
  const resolvedTagEntries: Array<[string, TagAction & { destination_account: string }]> = [];
  for (const [tag, action] of tagEntries) {
    const destResolved = resolveAccountId(
      allAccounts,
      action.destination_account,
      step.budget
    );
    if (!destResolved.ok) {
      throw new Error(`tag "${tag}": ${destResolved.error}`);
    }
    resolvedTagEntries.push([tag, { ...action, destination_account: destResolved.id }]);
  }

  const selectedAccounts = selectAccounts(allAccounts, srcResolved.spec!);

  const sourceTxFlat: ActualTransaction[] = [];
  for (const acct of selectedAccounts) {
    const txs = await actual.getTransactions(acct.id, startDate, endDate);
    sourceTxFlat.push(...(txs as ActualTransaction[]));
  }

  // Collect all unique destination account IDs referenced by the tag config
  const destAccountIds = new Set(
    resolvedTagEntries.map(([, action]) => action.destination_account)
  );

  // Read existing mirrored transactions from all destination accounts
  const existingBySourceId = new Map<string, ActualTransaction>();
  for (const destId of destAccountIds) {
    const destTxs = (await actual.getTransactions(
      destId,
      startDate,
      endDate
    )) as ActualTransaction[];
    for (const tx of destTxs) {
      if (!isABMirrorId(tx.imported_id)) continue;
      const parsed = parseImportedId(tx.imported_id as string);
      if (parsed?.budgetId === budgetId) {
        existingBySourceId.set(`${parsed.txId}:${destId}`, tx);
      }
    }
  }

  const selector = {
    accounts: step.source.accounts,
    requiredTags: step.source.requiredTags,
  };

  const diff = computeSplitDiff(
    sourceTxFlat,
    selector,
    resolvedTagEntries,
    existingBySourceId,
    budgetId,
    {
      splitMirrored: step.source.splitMirrored ?? false,
      onWarn: reporter
        ? (code, detail) => reporter.warn(code, detail)
        : undefined,
      stepIndex,
    }
  );

  if (reporter) {
    reporter.recordStep({
      type: "split",
      added: diff.toAdd.length,
      updated: diff.toUpdate.length,
    });
  }

  if (dryRun) {
    console.log(
      `  [dry-run] would add=${diff.toAdd.length} update=${diff.toUpdate.length}`
    );
    return;
  }

  for (const { accountId, tx } of diff.toAdd) {
    await actual.addTransactions(accountId, [tx]);
  }
  for (const { id, date, amount } of diff.toUpdate) {
    await actual.updateTransaction(id, { date, amount });
  }

  console.log(`  added=${diff.toAdd.length} updated=${diff.toUpdate.length}`);
}
