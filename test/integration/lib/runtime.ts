/** In-memory runtime structures for YAML-based sync engine integration tests. */

export type RuntimeSubTransaction = {
  id: string;
  date: string;
  amount: number;
  payee?: string | null;
  payee_name?: string | null;
  notes?: string | null;
  category?: string | null;
  cleared?: boolean | null;
  imported_id?: string | null;
};

export type RuntimeTransaction = {
  id: string;
  date: string;
  amount: number;
  payee?: string | null;
  payee_name?: string | null;
  notes?: string | null;
  category?: string | null;
  cleared?: boolean | null;
  imported_id?: string | null;
  is_parent?: boolean;
  is_child?: boolean;
  parent_id?: string | null;
  subtransactions?: RuntimeSubTransaction[];
  tombstone?: boolean;
};

export type RuntimeAccount = {
  id: string;
  name: string;
  offbudget: boolean;
  closed: boolean;
  transactions: Map<string, RuntimeTransaction>;
};

export type RuntimeBudget = {
  /** Deterministic runtime ID: "budget-{alias}" */
  id: string;
  alias: string;
  /** Keyed by runtime account UUID */
  accounts: Map<string, RuntimeAccount>;
  /** Keyed by account name (from fixture) */
  accountsByName: Map<string, RuntimeAccount>;
  /** Payee registry: UUID → name. Mimics the real Actual payees table. */
  payees: Map<string, string>;
  /** Reverse lookup: exact name → UUID. */
  payeesByName: Map<string, string>;
};

export type RuntimeEnv = {
  /** Keyed by budget alias */
  budgets: Map<string, RuntimeBudget>;
};

/** Find a transaction by its runtime ID across all accounts of a specific budget. */
export function findTransactionInBudget(
  budget: RuntimeBudget,
  id: string
): { tx: RuntimeTransaction; account: RuntimeAccount } | null {
  for (const account of budget.accounts.values()) {
    const tx = account.transactions.get(id);
    if (tx) return { tx, account };
  }
  return null;
}

/** Find a transaction by its runtime ID across the entire environment. */
export function findTransactionGlobally(
  env: RuntimeEnv,
  id: string
): { tx: RuntimeTransaction; account: RuntimeAccount; budget: RuntimeBudget } | null {
  for (const budget of env.budgets.values()) {
    const found = findTransactionInBudget(budget, id);
    if (found) return { ...found, budget };
  }
  return null;
}

/** Return non-tombstoned, non-is_child transactions within a date range. */
export function getAccountTransactions(
  account: RuntimeAccount,
  startDate: string,
  endDate: string
): RuntimeTransaction[] {
  return Array.from(account.transactions.values()).filter(
    (tx) => !tx.tombstone && !tx.is_child && tx.date >= startDate && tx.date <= endDate
  );
}
