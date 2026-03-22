/**
 * Account resolution: name -> ID translation and duplicate-name checks.
 *
 * - Config may use account names or IDs. IDs (UUID format) pass through.
 * - Names resolve to IDs via exact match. Duplicate names are forbidden.
 * - On duplicate-name failure, we dump IDs + basic info so users can pick the right one.
 */
import type { AccountsSpec } from "../config/schema";
import type { ActualAccount } from "../selector/types";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return UUID_REGEX.test(s);
}

export interface DuplicateNameError {
  budget: string;
  name: string;
  accounts: ActualAccount[];
}

/**
 * Checks for duplicate account names in a budget. Returns the first duplicate
 * found, or null if all names are unique.
 */
export function checkDuplicateNames(
  accounts: ActualAccount[],
  budgetAlias: string
): DuplicateNameError | null {
  const byName = new Map<string, ActualAccount[]>();
  for (const a of accounts) {
    const list = byName.get(a.name) ?? [];
    list.push(a);
    byName.set(a.name, list);
  }
  for (const [name, list] of byName) {
    if (list.length > 1) {
      return { budget: budgetAlias, name, accounts: list };
    }
  }
  return null;
}

/**
 * Formats a duplicate-name error with IDs and basic info so users can pick
 * the right ID for their config.
 */
export function formatDuplicateErrorForUser(err: DuplicateNameError): string {
  const lines: string[] = [
    `Duplicate account name "${err.name}" in budget "${err.budget}": multiple accounts share this name.`,
    "Use one of these IDs in your config:",
    "",
  ];
  for (const a of err.accounts) {
    const offbudget = a.offbudget ? "off-budget" : "on-budget";
    const closed = a.closed ? "closed" : "open";
    lines.push(`  id: ${a.id}  (${offbudget}, ${closed})`);
  }
  return lines.join("\n");
}

/**
 * Builds a name -> id map for accounts. Call only after checkDuplicateNames
 * returns null (no duplicates).
 */
function buildNameToIdMap(accounts: ActualAccount[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of accounts) {
    map.set(a.name, a.id);
  }
  return map;
}

function buildIdSet(accounts: ActualAccount[]): Set<string> {
  return new Set(accounts.map((a) => a.id));
}

export interface ResolveResult {
  ok: boolean;
  spec?: AccountsSpec;
  error?: string;
}

/**
 * Resolves an account spec (which may contain names or IDs) to a canonical
 * AccountsSpec using only IDs. Scope keywords "all", "on-budget", "off-budget"
 * pass through unchanged.
 *
 * Call only after checkDuplicateNames returns null for this budget.
 */
export function resolveAccountsSpec(
  accounts: ActualAccount[],
  spec: AccountsSpec,
  budgetAlias: string
): ResolveResult {
  const knownAccounts = accounts.map((a) => a.name).sort();
  const knownSuffix =
    knownAccounts.length > 0
      ? ` Known accounts in "${budgetAlias}": ${knownAccounts.join(", ")}`
      : "";

  const nameToId = buildNameToIdMap(accounts);
  const idSet = buildIdSet(accounts);

  if (spec === "all" || spec === "on-budget" || spec === "off-budget") {
    return { ok: true, spec };
  }

  function resolveOne(value: string): string | null {
    if (isUuid(value)) {
      return idSet.has(value) ? value : null;
    }
    const id = nameToId.get(value);
    return id ?? null;
  }

  if (Array.isArray(spec)) {
    const resolved: string[] = [];
    for (const v of spec) {
      const id = resolveOne(v);
      if (id === null) {
        return {
          ok: false,
          error: `Account "${v}" not found in budget "${budgetAlias}".${knownSuffix}`,
        };
      }
      resolved.push(id);
    }
    return { ok: true, spec: resolved };
  }

  // Single string
  const id = resolveOne(spec);
  if (id === null) {
    return {
      ok: false,
      error: `Account "${spec}" not found in budget "${budgetAlias}".${knownSuffix}`,
    };
  }
  return { ok: true, spec: id };
}

/**
 * Resolves a single account ID or name to an ID.
 */
export function resolveAccountId(
  accounts: ActualAccount[],
  value: string,
  budgetAlias: string
): { ok: true; id: string } | { ok: false; error: string } {
  const nameToId = buildNameToIdMap(accounts);
  const idSet = buildIdSet(accounts);

  if (isUuid(value)) {
    return idSet.has(value)
      ? { ok: true, id: value }
      : { ok: false, error: `Account "${value}" not found in budget "${budgetAlias}"` };
  }
  const id = nameToId.get(value);
  return id
    ? { ok: true, id }
    : { ok: false, error: `Account "${value}" not found in budget "${budgetAlias}"` };
}
