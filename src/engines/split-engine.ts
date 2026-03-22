/**
 * Split engine adapter: implements SyncEngine for split steps.
 * Tag-based routing with amount multiplier, multiple destinations.
 */
import * as actual from "@actual-app/api";
import { formatImportedId } from "../util/imported-id";
import { parseTags } from "../util/tags";
import { resolveAccountsSpec, resolveAccountId } from "../util/account-resolver";
import type { SplitStep, TagAction } from "../config/schema";
import type { ActualTransaction, NewTransaction } from "../selector/types";
import type { BudgetManager } from "../client/budget-manager";
import type { EngineOpts, ProposeResult, SyncEngine } from "../diff/sync-engine";

export async function buildSplitOpts(
  step: SplitStep,
  opts: {
    startDate: string;
    endDate: string;
    dryRun: boolean;
    reporter?: EngineOpts["reporter"];
    stepIndex?: number;
    rootTxIndex?: EngineOpts["rootTxIndex"];
    maxChangesPerStep?: number;
  },
  manager: BudgetManager
): Promise<EngineOpts> {
  const budgetInfo = await manager.open(step.budget);
  const allAccounts = (await actual.getAccounts()) as import("../selector/types").ActualAccount[];

  const srcResolved = resolveAccountsSpec(
    allAccounts,
    step.source.accounts,
    step.budget
  );
  if (!srcResolved.ok) throw new Error(srcResolved.error);

  const tagEntries: Array<[string, { multiplier: number; destination_account: string }]> = [];
  for (const [tag, action] of Object.entries(step.tags) as Array<[string, TagAction]>) {
    const destResolved = resolveAccountId(
      allAccounts,
      action.destination_account,
      step.budget
    );
    if (!destResolved.ok) throw new Error(`tag "${tag}": ${destResolved.error}`);
    tagEntries.push([tag, { ...action, destination_account: destResolved.id }]);
  }

  const destAccountIds = [...new Set(tagEntries.map(([, a]) => a.destination_account))];
  let defaultAction: EngineOpts["defaultAction"];
  if (step.default) {
    const destResolved = resolveAccountId(
      allAccounts,
      step.default.destination_account,
      step.budget
    );
    if (!destResolved.ok) throw new Error(`default: ${destResolved.error}`);
    defaultAction = { ...step.default, destination_account: destResolved.id };
    if (!destAccountIds.includes(destResolved.id)) destAccountIds.push(destResolved.id);
  }

  const isBroadSpec =
    step.source.accounts === "all" ||
    step.source.accounts === "on-budget" ||
    step.source.accounts === "off-budget";
  const excludeAccountIds = isBroadSpec ? new Set(destAccountIds) : undefined;

  return {
    sourceBudgetAlias: step.budget,
    sourceBudgetId: budgetInfo.budgetId,
    sourceAccountsSpec: step.source.accounts,
    requiredTags: step.source.requiredTags,
    destBudgetAlias: step.budget,
    destBudgetId: budgetInfo.budgetId,
    destAccountIds,
    startDate: opts.startDate,
    endDate: opts.endDate,
    dryRun: opts.dryRun,
    reporter: opts.reporter,
    stepIndex: opts.stepIndex,
    stepType: "split",
    deleteEnabled: step.delete,
    updateFields: step.updateFields,
    tagEntries,
    excludeAccountIds,
    defaultAction,
    rootTxIndex: opts.rootTxIndex,
    maxChangesPerStep: opts.maxChangesPerStep,
  };
}

export function createSplitEngine(step: SplitStep): SyncEngine {
  return {
    propose(sourceTxs, opts): ProposeResult {
      const tagEntries = opts.tagEntries ?? [];
      const desired = new Map<string, { accountId: string; tx: NewTransaction }>();
      let scopeMatchNoActionTagCount = 0;

      for (const tx of sourceTxs) {
        const { tags: txTags } = parseTags(tx.notes);
        const matchingTags = tagEntries.filter(([tag]) =>
          txTags.includes(tag.toLowerCase())
        );

        if (matchingTags.length === 0) {
          if (opts.defaultAction) {
            const action = opts.defaultAction;
            const amount = Math.round(tx.amount * action.multiplier);
            const logicalId = `${tx.id}::default::${action.destination_account}`;
            // Key must match indexExistingMirrored: parsed.txId:tx.account
            const key = `${logicalId}:${action.destination_account}`;
            desired.set(key, {
              accountId: action.destination_account,
              tx: {
                date: tx.date,
                amount,
                payee: tx.payee ?? undefined,
                notes: tx.notes ?? undefined,
                category: tx.category ?? undefined,
                cleared: tx.cleared,
                imported_id: formatImportedId(opts.sourceBudgetId, logicalId),
              },
            });
          } else {
            scopeMatchNoActionTagCount++;
          }
          continue;
        }

        if (matchingTags.length > 1) {
          opts.reporter?.warn("splitter.multiTagMatch", {
            txId: tx.id,
            payee: tx.payee ?? "?",
            date: tx.date,
            matchingTags: matchingTags.map(([t]) => t),
          });
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
            payee: tx.payee ?? undefined,
            notes: tx.notes ?? undefined,
            category: tx.category ?? undefined,
            cleared: tx.cleared,
            imported_id: formatImportedId(opts.sourceBudgetId, tx.id),
          },
        });
      }

      if (scopeMatchNoActionTagCount > 0) {
        opts.reporter?.warn("splitter.scopeMatchNoActionTag", {
          stepIndex: opts.stepIndex ?? 0,
          count: scopeMatchNoActionTagCount,
        });
      }

      return { desired };
    },
    getDestBudgetId(opts) {
      return opts.destBudgetId;
    },
    getDestAccountIds(opts) {
      return opts.destAccountIds;
    },
  };
}
