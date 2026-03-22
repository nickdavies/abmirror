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
    startDate: string;
    endDate: string;
    dryRun: boolean;
    reporter?: EngineOpts["reporter"];
    globalTxIndex?: EngineOpts["globalTxIndex"];
    rootTxIndex?: EngineOpts["rootTxIndex"];
    maxChangesPerStep?: number;
    destOwnerMap?: EngineOpts["destOwnerMap"];
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
    startDate: opts.startDate,
    endDate: opts.endDate,
    dryRun: opts.dryRun,
    reporter: opts.reporter,
    stepType: "mirror",
    deleteEnabled: step.delete,
    updateFields: step.updateFields,
    globalTxIndex: opts.globalTxIndex,
    rootTxIndex: opts.rootTxIndex,
    maxChangesPerStep: opts.maxChangesPerStep,
    destOwnerMap: opts.destOwnerMap,
  };
}

/** Stable sort so duplicate keys (e.g. same origin) resolve to the same tx each round. */
function sortSourceTxs<T extends { date: string; amount: number; notes?: string | null; id: string }>(
  txs: T[]
): T[] {
  return [...txs].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.amount - b.amount ||
      (a.notes ?? "").localeCompare(b.notes ?? "") ||
      a.id.localeCompare(b.id)
  );
}

export function createMirrorEngine(step: MirrorStep): SyncEngine {
  return {
    propose(sourceTxs, opts): ProposeResult {
      const destAccountId = opts.destAccountIds[0]!;
      const desired = new Map<string, { accountId: string; tx: NewTransaction }>();

      for (const sourceTx of sortSourceTxs(sourceTxs)) {
        // Do not mirror a tx back to its origin budget — avoids direct round-trip loops.
        if (isABMirrorId(sourceTx.imported_id)) {
          const parsed = parseImportedId(sourceTx.imported_id as string);
          if (!parsed) {
            // malformed — skip
            continue;
          }
          // Within-round: skip if canonical source is the dest budget
          if (parsed.budgetId === opts.destBudgetId) continue;

          // Skip if dest already has this canonical entry AND another step "owns"
          // entries with this canonical budgetId in the dest. Owner steps have
          // sourceBudgetId matching parsed.budgetId and run earlier in the pipeline,
          // so they hold the authoritative value. Without this check, a non-owner
          // step reading stale data could overwrite the owner's fresh update.
          if (opts.globalTxIndex && parsed.budgetId !== opts.sourceBudgetId) {
            const canonicalKey = `${parsed.budgetId}:${parsed.txId}`;
            const destKey = `${opts.destBudgetId}:${destAccountId}`;
            if (opts.globalTxIndex.get(canonicalKey)?.has(destKey)) {
              const destOwners = opts.destOwnerMap?.get(destAccountId);
              if (destOwners?.has(parsed.budgetId)) continue;
            }
          }
        }

        const amount = step.invert ? -sourceTx.amount : sourceTx.amount;
        // Within same budget: pass category through. Across budgets: use mapping or null.
        const sameBudget = opts.sourceBudgetId === opts.destBudgetId;
        const category = sameBudget
          ? (sourceTx.category ?? undefined)
          : step.categoryMapping && sourceTx.category
            ? (step.categoryMapping[sourceTx.category] ?? undefined)
            : undefined;

        if (isABMirrorId(sourceTx.imported_id)) {
          const parsed = parseImportedId(sourceTx.imported_id as string);
          if (parsed) {
            // Use canonical key so we match existing (same logical origin). Always apply step
            // invert for amount: hub→personal needs invert (e.g. gamma/PayBeta -2000 → beta/Recv
            // +2000); personal→hub needs invert (beta/Recv +2000 → gamma/PayBeta -2000).
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
                imported_id: formatImportedId(parsed.budgetId, parsed.txId),
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
