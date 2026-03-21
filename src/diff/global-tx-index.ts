/**
 * Global pre-pass transaction index for cross-budget loop prevention.
 *
 * Maps canonical origin keys ("budgetId:txId") to the set of budget:account
 * locations where a copy already exists. Used by the mirror engine to skip
 * placing a transaction where a copy from the same canonical source is already
 * present, preventing oscillation in multi-budget pipelines.
 */
import * as actual from "@actual-app/api";
import { isABMirrorId, parseImportedId } from "../util/imported-id";
import type { BudgetManager } from "../client/budget-manager";

/** key: "canonicalBudgetId:canonicalTxId"  →  Set<"budgetId:accountId"> */
export type GlobalTxIndex = Map<string, Set<string>>;

/** key: budgetId  →  Set<txId> for all non-ABMirror (root/original) transactions */
export type RootTxIndex = Map<string, Set<string>>;

function lookbackStart(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Scan all budgets within the lookback window and build:
 * - globalTxIndex: where each ABMirror canonical source tx has been copied
 * - rootTxIndex: all non-ABMirror (root/original) tx IDs per budget
 */
export async function buildGlobalTxIndex(
  budgetAliases: string[],
  lookbackDays: number,
  manager: BudgetManager
): Promise<{ globalTxIndex: GlobalTxIndex; rootTxIndex: RootTxIndex }> {
  const globalTxIndex: GlobalTxIndex = new Map();
  const rootTxIndex: RootTxIndex = new Map();
  const startDate = lookbackStart(lookbackDays);
  const endDate = new Date().toISOString().slice(0, 10);

  for (const alias of budgetAliases) {
    const budgetInfo = await manager.open(alias);
    const accounts = (await actual.getAccounts()) as Array<{ id: string }>;

    for (const account of accounts) {
      const txs = (await actual.getTransactions(
        account.id,
        startDate,
        endDate
      )) as Array<{ id: string; imported_id?: string | null }>;

      for (const tx of txs) {
        if (isABMirrorId(tx.imported_id)) {
          const parsed = parseImportedId(tx.imported_id as string);
          if (!parsed) continue;
          const key = `${parsed.budgetId}:${parsed.txId}`;
          if (!globalTxIndex.has(key)) globalTxIndex.set(key, new Set());
          globalTxIndex.get(key)!.add(`${budgetInfo.budgetId}:${account.id}`);
        } else {
          if (!rootTxIndex.has(budgetInfo.budgetId)) rootTxIndex.set(budgetInfo.budgetId, new Set());
          rootTxIndex.get(budgetInfo.budgetId)!.add(tx.id);
        }
      }
    }
  }

  return { globalTxIndex, rootTxIndex };
}
