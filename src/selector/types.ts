/**
 * Local types mirroring the shapes we use from @actual-app/api.
 * Using our own definitions avoids tight coupling to the upstream package's
 * internal type names.
 */

export interface ActualAccount {
  id: string;
  name: string;
  offbudget?: boolean;
  closed?: boolean;
}

export interface ActualCategory {
  id: string;
  name: string;
  /** group_id links to APICategoryGroupEntity.id */
  group_id: string;
}

export interface ActualTransaction {
  id: string;
  account: string;
  date: string;
  amount: number;
  payee?: string | null;
  payee_name?: string | null;
  imported_id?: string | null;
  notes?: string | null;
  category?: string | null;
  cleared?: boolean;
  is_parent?: boolean;
  is_child?: boolean;
  parent_id?: string | null;
  subtransactions?: ActualTransaction[];
  tombstone?: boolean;
}

/**
 * Fields accepted when creating a new transaction via addTransactions.
 * Matches Omit<ImportTransactionEntity, 'account'> from @actual-app/api.
 */
export interface NewTransaction {
  date: string;
  amount?: number;
  payee?: string;
  payee_name?: string;
  imported_payee?: string;
  category?: string;
  notes?: string;
  imported_id?: string;
  cleared?: boolean;
}

export interface SelectorConfig {
  accounts: import("../config/schema").AccountsSpec;
  requiredTags?: string[];
}
