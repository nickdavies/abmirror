#!/usr/bin/env npx tsx
/**
 * Capture a snapshot of budget/account/transaction state from a running Actual
 * server and write it as a normalized YAML fixture file.
 *
 * Use this to generate before.yaml and after.yaml for YAML-based integration
 * test cases (see test/integration/cases/).
 *
 * Usage:
 *   cd localdev
 *   npx tsx snapshot.ts --out before.yaml
 *   ./run-pipeline.sh --pipeline my-pipeline.yaml
 *   npx tsx snapshot.ts --out after.yaml
 *
 *   # Then copy the three files to a new test case:
 *   mkdir -p ../test/integration/cases/my-case
 *   cp before.yaml after.yaml my-pipeline.yaml ../test/integration/cases/my-case/
 *   # Rename my-pipeline.yaml to pipeline.yaml inside the case dir.
 *
 * Options:
 *   --config PATH          Base config file (default: ./config.yaml)
 *   --budgets a,b,c        Comma-separated budget aliases to snapshot (default: all from config)
 *   --out PATH             Output YAML file (required)
 *
 * Notes on ID normalization:
 *   Placeholder IDs (TX-1, TX-2, TX-3-SUB-1, …) are assigned by sorting all
 *   visible transactions globally by:
 *     (budgetAlias, accountName, date, notes ?? '', payee_name ?? ''), then amount.
 *   imported_id values are rewritten from "ABMirror:<localBudgetId>:<uuid>" to
 *   "ABMirror:<alias>:<TX-N>" using the same sort-derived map.
 *   Budget aliases in imported_id are resolved using local budget IDs discovered
 *   by opening each budget; references to unknown budget IDs are left as-is.
 */

import * as actual from "@actual-app/api";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import {
  isABMirrorId,
  parseImportedId,
  formatImportedId,
} from "../src/util/imported-id";

// ─── Types ────────────────────────────────────────────────────────────────────

type SubSnapshot = {
  id: string;
  date: string;
  amount: number;
  payee_name: string | null;
  notes: string | null;
  category: string | null;
  cleared: boolean | null;
  imported_id: string | null;
};

type TxSnapshot = {
  id: string;
  date: string;
  amount: number;
  payee_name: string | null;
  notes: string | null;
  category: string | null;
  cleared: boolean | null;
  imported_id: string | null;
  subs: SubSnapshot[];
};

type AccountSnapshot = {
  offbudget?: boolean;
  closed?: boolean;
  transactions: TxSnapshot[];
};

type BudgetSnapshot = {
  accounts: Record<string, AccountSnapshot>;
};

type FixtureSnapshot = {
  budgets: Record<string, BudgetSnapshot>;
};

// Raw Actual API types (minimal surface we need)
type ApiAccount = { id: string; name: string; offbudget?: boolean; closed?: boolean };
type ApiTransaction = {
  id: string;
  account: string;
  date: string;
  amount: number;
  payee_name?: string | null;
  notes?: string | null;
  category?: string | null;
  cleared?: boolean | null;
  imported_id?: string | null;
  is_parent?: boolean;
  is_child?: boolean;
  tombstone?: boolean;
  subtransactions?: ApiTransaction[];
};

// ─── Arg parsing ──────────────────────────────────────────────────────────────

type Args = {
  configPath: string;
  budgetAliases: string[] | null; // null = all from config
  outPath: string;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let configPath = join(import.meta.dirname ?? __dirname, "config.yaml");
  let budgetAliases: string[] | null = null;
  let outPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && args[i + 1]) {
      configPath = args[i + 1]!;
      i++;
    } else if (args[i] === "--budgets" && args[i + 1]) {
      budgetAliases = args[i + 1]!.split(",").map((s) => s.trim());
      i++;
    } else if (args[i] === "--out" && args[i + 1]) {
      outPath = args[i + 1]!;
      i++;
    }
  }

  if (!outPath) {
    console.error(
      "Usage: npx tsx snapshot.ts [--config PATH] [--budgets a,b] --out PATH"
    );
    process.exit(1);
  }

  return { configPath, budgetAliases, outPath };
}

// ─── Normalization ────────────────────────────────────────────────────────────

type TxWithCtx = {
  budgetAlias: string;
  accountName: string;
  tx: ApiTransaction;
};

function sortKey(item: TxWithCtx): string {
  return `${item.budgetAlias}\0${item.accountName}\0${item.tx.date}\0${item.tx.notes ?? ""}\0${item.tx.payee_name ?? ""}`;
}

function buildIdMaps(allTxs: TxWithCtx[]): {
  txToPlaceholder: Map<string, string>;
  budgetIdToAlias: Map<string, string>;
} {
  // budgetIdToAlias is passed in via context; we handle it outside this function.
  const txToPlaceholder = new Map<string, string>();
  let txN = 0;

  for (const { tx } of allTxs) {
    txN++;
    const placeholder = `TX-${txN}`;
    txToPlaceholder.set(tx.id, placeholder);
    if (tx.subtransactions) {
      let subN = 0;
      for (const sub of tx.subtransactions) {
        subN++;
        txToPlaceholder.set(sub.id, `${placeholder}-SUB-${subN}`);
      }
    }
  }

  return { txToPlaceholder, budgetIdToAlias: new Map() };
}

function rewriteImportedId(
  importedId: string | null | undefined,
  txToPlaceholder: Map<string, string>,
  budgetIdToAlias: Map<string, string>
): string | null {
  if (!isABMirrorId(importedId)) return importedId ?? null;
  const parsed = parseImportedId(importedId as string);
  if (!parsed) return importedId as string;
  const alias = budgetIdToAlias.get(parsed.budgetId);
  const placeholder = txToPlaceholder.get(parsed.txId);
  if (!alias || !placeholder) return importedId as string; // unknown ref — leave as-is
  return formatImportedId(alias, placeholder);
}

function txToSnapshot(
  tx: ApiTransaction,
  txToPlaceholder: Map<string, string>,
  budgetIdToAlias: Map<string, string>
): TxSnapshot {
  return {
    id: txToPlaceholder.get(tx.id) ?? tx.id,
    date: tx.date,
    amount: tx.amount,
    payee_name: tx.payee_name ?? null,
    notes: tx.notes ?? null,
    category: tx.category ?? null,
    cleared: tx.cleared ?? null,
    imported_id: rewriteImportedId(tx.imported_id, txToPlaceholder, budgetIdToAlias),
    subs: (tx.subtransactions ?? []).map((sub) => ({
      id: txToPlaceholder.get(sub.id) ?? sub.id,
      date: sub.date,
      amount: sub.amount,
      payee_name: sub.payee_name ?? null,
      notes: sub.notes ?? null,
      category: sub.category ?? null,
      cleared: sub.cleared ?? null,
      imported_id: rewriteImportedId(sub.imported_id, txToPlaceholder, budgetIdToAlias),
    })),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const TX_START = "2000-01-01";
const TX_END = "2100-01-01";

async function main(): Promise<void> {
  const { configPath, budgetAliases, outPath } = parseArgs();

  // Read config.yaml to get server URL, password, and budget sync IDs
  const configRaw = readFileSync(configPath, "utf-8");
  const config = parse(configRaw) as {
    server: { url: string; password?: string };
    dataDir: string;
    budgets: Record<string, { syncId: string; encrypted?: boolean }>;
  };

  const serverUrl = config.server.url;
  const serverPassword = config.server.password;
  const dataDir = mkdtempSync(join(tmpdir(), "ab-mirror-snapshot-"));

  process.env.ACTUAL_DATA_DIR = dataDir;

  const aliases = budgetAliases ?? Object.keys(config.budgets);

  console.log(`Connecting to ${serverUrl}...`);
  await actual.init({
    dataDir,
    serverURL: serverUrl,
    ...(serverPassword ? { password: serverPassword } : {}),
  });

  // Map local budget IDs → aliases (needed for imported_id rewriting).
  // We discover the local ID by downloading each budget and checking its prefs.
  const budgetIdToAlias = new Map<string, string>();

  const allTxsGlobal: TxWithCtx[] = [];
  const budgets: Record<string, BudgetSnapshot> = {};

  for (const alias of aliases) {
    const budgetCfg = config.budgets[alias];
    if (!budgetCfg) {
      console.warn(`  Warning: alias "${alias}" not found in config, skipping.`);
      continue;
    }

    console.log(`  Opening budget "${alias}" (syncId=${budgetCfg.syncId})...`);
    await actual.downloadBudget(budgetCfg.syncId);

    // Discover local budget ID for imported_id normalization
    const allBudgets = await actual.getBudgets();
    const found = allBudgets.find((b) => b.groupId === budgetCfg.syncId);
    if (found?.id) {
      budgetIdToAlias.set(found.id, alias);
    }

    const accounts = (await actual.getAccounts()) as ApiAccount[];
    const acctSnapshots: Record<string, AccountSnapshot> = {};

    for (const account of accounts) {
      const rawTxs = (await actual.getTransactions(
        account.id,
        TX_START,
        TX_END
      )) as ApiTransaction[];

      // Keep only visible top-level (non-tombstoned, non-child) transactions
      const visibleTxs = rawTxs.filter((tx) => !tx.tombstone && !tx.is_child);

      for (const tx of visibleTxs) {
        allTxsGlobal.push({ budgetAlias: alias, accountName: account.name, tx });
      }

      const acctSnap: AccountSnapshot = { transactions: [] }; // filled after normalization
      if (account.offbudget) acctSnap.offbudget = true;
      if (account.closed) acctSnap.closed = true;
      acctSnapshots[account.name] = acctSnap;
    }

    budgets[alias] = { accounts: acctSnapshots };
  }

  await actual.shutdown();

  // ── Global sort (same algorithm as exportRuntimeToFixture) ──────────────────
  allTxsGlobal.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka !== kb) return ka.localeCompare(kb);
    return a.tx.amount - b.tx.amount;
  });

  // ── Assign placeholder IDs ──────────────────────────────────────────────────
  const txToPlaceholder = new Map<string, string>();
  let txN = 0;
  for (const { tx } of allTxsGlobal) {
    txN++;
    const placeholder = `TX-${txN}`;
    txToPlaceholder.set(tx.id, placeholder);
    if (tx.subtransactions) {
      let subN = 0;
      for (const sub of tx.subtransactions) {
        subN++;
        txToPlaceholder.set(sub.id, `${placeholder}-SUB-${subN}`);
      }
    }
  }

  // ── Populate account snapshots ──────────────────────────────────────────────
  for (const { budgetAlias, accountName, tx } of allTxsGlobal) {
    const acctSnap = budgets[budgetAlias]?.accounts[accountName];
    if (!acctSnap) continue;
    acctSnap.transactions.push(txToSnapshot(tx, txToPlaceholder, budgetIdToAlias));
  }

  // ── Write output ────────────────────────────────────────────────────────────
  const { stringify } = await import("yaml");
  const snapshot: FixtureSnapshot = { budgets };
  const yaml = stringify(snapshot, { lineWidth: 0 });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outPath, yaml, "utf-8");
  console.log(`\nSnapshot written to ${outPath}`);
  console.log(`  ${txN} transactions normalized across ${aliases.length} budget(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
