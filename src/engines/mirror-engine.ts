/**
 * Mirror engine adapter: implements SyncEngine for mirror steps.
 * 1:1 copy (or invert), single destination, optional category mapping.
 */
import * as actual from "@actual-app/api";
import { formatImportedId, isABMirrorId, parseImportedId } from "../util/imported-id";
import { resolveAccountsSpec, resolveAccountId } from "../util/account-resolver";
import type { MirrorStep } from "../config/schema";
import type { ActualTransaction, NewTransaction } from "../selector/types";
import type { BudgetManager } from "../client/budget-manager";
import type { EngineOpts, ProposeResult, SyncEngine } from "../diff/sync-engine";

export async function buildMirrorOpts(
  step: MirrorStep,
  opts: {
    lookbackDays: number;
    dryRun: boolean;
    reporter?: EngineOpts["reporter"];
  },
  manager: BudgetManager
): Promise<EngineOpts> {
  // Use cached budget IDs from preflight; only open dest to resolve account.
  // Opening both budgets caused extra syncs that can fail during pipeline (sync_engine).
  const sourceInfo = manager.getInfo(step.source.budget);
  const destInfo = await manager.open(step.destination.budget);
  const destAccounts = (await actual.getAccounts()) as import("../selector/types").ActualAccount[];
  const destResolved = resolveAccountId(
    destAccounts,
    step.destination.account,
    step.destination.budget
  );
  if (!destResolved.ok) throw new Error(destResolved.error);

  return {
    sourceBudgetAlias: step.source.budget,
    sourceBudgetId: sourceInfo.budgetId,
    sourceAccountsSpec: step.source.accounts,
    requiredTags: step.source.requiredTags,
    destBudgetAlias: step.destination.budget,
    destBudgetId: destInfo.budgetId,
    destAccountIds: [destResolved.id],
    lookbackDays: opts.lookbackDays,
    dryRun: opts.dryRun,
    reporter: opts.reporter,
    stepType: "mirror",
    deleteEnabled: step.delete,
  };
}

export function createMirrorEngine(step: MirrorStep): SyncEngine {
  return {
    propose(sourceTxs, opts): ProposeResult {
      const destAccountId = opts.destAccountIds[0]!;
      const desired = new Map<string, { accountId: string; tx: NewTransaction }>();

      for (const sourceTx of sourceTxs) {
        const amount = step.invert ? -sourceTx.amount : sourceTx.amount;
        const category =
          step.categoryMapping && sourceTx.category
            ? (step.categoryMapping[sourceTx.category] ?? undefined)
            : undefined;

        if (isABMirrorId(sourceTx.imported_id)) {
          const parsed = parseImportedId(sourceTx.imported_id as string);
          if (parsed?.budgetId === opts.destBudgetId) {
            // Round-trip: dest already has it. Use canonical key and imported_id so we match existing.
            const key = `${parsed.txId}:${destAccountId}`;
            desired.set(key, {
              accountId: destAccountId,
              tx: {
                date: sourceTx.date,
                amount,
                payee_name: sourceTx.payee_name ?? undefined,
                notes: sourceTx.notes ?? undefined,
                category,
                cleared: sourceTx.cleared,
                imported_id: formatImportedId(opts.destBudgetId, parsed.txId),
              },
            });
            continue;
          }
        }

        const key = `${sourceTx.id}:${destAccountId}`;
        desired.set(key, {
          accountId: destAccountId,
          tx: {
            date: sourceTx.date,
            amount,
            payee_name: sourceTx.payee_name ?? undefined,
            notes: sourceTx.notes ?? undefined,
            category,
            cleared: sourceTx.cleared,
            imported_id: formatImportedId(opts.sourceBudgetId, sourceTx.id),
          },
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
