/**
 * Shared transaction source selector used by both the syncer and splitter.
 * Handles account filtering (all/on-budget/off-budget/specific IDs) and
 * required-tag filtering (AND logic across all tags).
 */
import { hasTags } from "../util/tags";
import type { AccountsSpec } from "../config/schema";
import type { ActualAccount, ActualTransaction, SelectorConfig } from "./types";

export function selectAccounts(
  accounts: ActualAccount[],
  spec: AccountsSpec
): ActualAccount[] {
  const open = accounts.filter((a) => !a.closed);
  if (spec === "all") return open;
  if (spec === "on-budget") return open.filter((a) => !a.offbudget);
  if (spec === "off-budget") return open.filter((a) => a.offbudget);
  if (Array.isArray(spec)) {
    const ids = new Set(spec);
    return accounts.filter((a) => ids.has(a.id));
  }
  // Single account ID string
  return accounts.filter((a) => a.id === spec);
}

function matchesSelector(
  tx: ActualTransaction,
  selector: SelectorConfig
): boolean {
  const required = selector.requiredTags ?? [];
  return hasTags(tx.notes, required);
}

/**
 * Yields transactions that match the selector. Split parents are never
 * yielded directly -- each subtransaction is evaluated independently.
 * Top-level is_child entries are skipped (they're in the parent's
 * subtransactions array).
 */
export function* selectTransactions(
  transactions: ActualTransaction[],
  selector: SelectorConfig
): Generator<ActualTransaction> {
  for (const tx of transactions) {
    if (tx.is_child) continue; // handled via parent.subtransactions

    if (tx.is_parent && tx.subtransactions && tx.subtransactions.length > 0) {
      for (const sub of tx.subtransactions) {
        if (matchesSelector(sub, selector)) {
          yield sub;
        }
      }
    } else {
      if (matchesSelector(tx, selector)) {
        yield tx;
      }
    }
  }
}
