/**
 * list-accounts: Dump account names to IDs for config discovery.
 * Shows all accounts with enough info to pick the right ID when names are ambiguous.
 */
import * as actual from "@actual-app/api";
import type { Config } from "../config/schema";
import type { BudgetManager } from "../client/budget-manager";
import type { ActualAccount } from "../selector/types";
import { checkDuplicateNames } from "../util/account-resolver";

type AccountWithBalance = ActualAccount & { balance_current?: number | null };

export interface ListAccountsOptions {
  config: Config;
  manager: BudgetManager;
  /** If set, only list this budget. Otherwise list all budgets in config. */
  budgetAlias?: string;
}

function formatBalance(bal: number | null | undefined): string {
  if (bal == null) return "";
  return `  balance: ${bal}`;
}

export async function runListAccounts(opts: ListAccountsOptions): Promise<void> {
  const { config, manager, budgetAlias } = opts;

  const aliases = budgetAlias
    ? [budgetAlias]
    : Object.keys(config.budgets);

  for (const alias of aliases) {
    if (!config.budgets[alias]) {
      console.error(`Unknown budget alias: "${alias}"`);
      process.exit(1);
    }

    await manager.download(alias);
    const accounts = (await actual.getAccounts()) as AccountWithBalance[];

    const dup = checkDuplicateNames(accounts, alias);
    if (dup) {
      console.log(`\nBudget: ${alias}`);
      console.log("  (duplicate account names - use IDs in config to disambiguate)");
      console.log("---");
    } else {
      console.log(`\nBudget: ${alias}`);
      console.log("---");
    }

    const byName = new Map<string, AccountWithBalance[]>();
    for (const a of accounts) {
      const list = byName.get(a.name) ?? [];
      list.push(a);
      byName.set(a.name, list);
    }

    const rows = accounts.map((a) => {
      const typeLabel = a.offbudget ? "off-budget" : "on-budget";
      const statusLabel = a.closed ? "closed" : "open";
      const dupNote = (byName.get(a.name)?.length ?? 0) > 1 ? "  (duplicate name)" : "";
      const bal = formatBalance(a.balance_current);
      return { name: a.name, id: a.id, typeLabel, statusLabel, bal, dupNote };
    });

    const maxName = Math.max(1, ...rows.map((r) => r.name.length));
    const maxId = Math.max(1, ...rows.map((r) => r.id.length));
    const maxType = Math.max(1, ...rows.map((r) => r.typeLabel.length));
    const maxStatus = Math.max(1, ...rows.map((r) => r.statusLabel.length));

    for (const r of rows) {
      const namePad = r.name.padEnd(maxName);
      const idPad = r.id.padEnd(maxId);
      const typePad = r.typeLabel.padEnd(maxType);
      const statusPad = r.statusLabel.padEnd(maxStatus);
      console.log(`  ${namePad}  ${idPad}  ${typePad}  ${statusPad}${r.bal}${r.dupNote}`);
    }
  }
}
