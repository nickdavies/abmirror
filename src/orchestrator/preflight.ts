/**
 * Preflight validation: runs before any pipeline step executes.
 *
 * Downloads all referenced budgets, then validates:
 *  - No duplicate account names in any budget (fail fast with actionable dump)
 *  - All budget aliases in pipeline exist in config
 *  - All account IDs/names (source and destination) exist in their budgets
 *  - All category IDs in category mappings exist
 *  - Same-budget mirror steps don't have overlapping source/dest accounts
 *  - Tag strings start with #
 *
 * All errors are collected and reported together.
 */
import * as actual from "@actual-app/api";
import { q, aqlQuery } from "@actual-app/api";
import type { AccountsSpec, Config, MirrorStep, SplitStep } from "../config/schema";
import { selectAccounts } from "../selector/index";
import type { BudgetManager } from "../client/budget-manager";
import type { ActualAccount, ActualCategory } from "../selector/types";
import {
  checkDuplicateNames,
  formatDuplicateErrorForUser,
  resolveAccountsSpec,
  resolveAccountId,
} from "../util/account-resolver";
import type { RunReporter } from "../notify/reporter";
import { validatePipelineGraph, type ResolvedStep } from "../graph/validator";

export interface PreflightResult {
  ok: boolean;
  errors: string[];
}

export async function runPreflight(
  config: Config,
  manager: BudgetManager,
  reporter?: RunReporter
): Promise<PreflightResult> {
  const errors: string[] = [];

  // --- Step 1: Collect and validate all referenced budget aliases ---
  const referencedAliases = new Set<string>();
  for (const step of config.pipeline) {
    if (step.type === "split") {
      referencedAliases.add(step.budget);
    } else if (step.type === "mirror") {
      referencedAliases.add(step.source.budget);
      referencedAliases.add(step.destination.budget);
    }
  }

  for (const alias of referencedAliases) {
    if (!config.budgets[alias]) {
      errors.push(`Pipeline references unknown budget alias: "${alias}"`);
    }
  }

  // Validate tag syntax across all steps
  for (let i = 0; i < config.pipeline.length; i++) {
    const step = config.pipeline[i]!;
    const label = `step[${i}] (${step.type})`;

    if (step.type === "split") {
      validateTagStrings(
        [...(step.source.requiredTags ?? []), ...Object.keys(step.tags)],
        label,
        errors
      );
    } else if (step.type === "mirror") {
      validateTagStrings(step.source.requiredTags ?? [], label, errors);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // --- Step 2: Download all referenced budgets ---
  for (const alias of referencedAliases) {
    try {
      await manager.download(alias);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause ? ` (cause: ${String(err.cause)})` : "";
      const stack = err instanceof Error && err.stack ? `\n  ${err.stack.split("\n").slice(1, 4).join("\n  ")}` : "";
      errors.push(`Failed to download budget "${alias}": ${msg}${cause}${stack}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // --- Step 2b: Check for duplicate account names (fail fast with actionable dump) ---
  for (const alias of referencedAliases) {
    const accounts = await getAccountsForBudget(alias, manager);
    const dup = checkDuplicateNames(accounts, alias);
    if (dup) {
      errors.push(formatDuplicateErrorForUser(dup));
      return { ok: false, errors };
    }
  }

  // --- Step 3: Validate each step's accounts and category mappings ---
  const resolvedSteps: ResolvedStep[] = [];

  for (let i = 0; i < config.pipeline.length; i++) {
    const step = config.pipeline[i]!;
    const label = `step[${i}] (${step.type})`;

    if (step.type === "split") {
      const resolved = await validateSplitStep(step, label, manager, errors, i, reporter);
      if (resolved) resolvedSteps.push(resolved);
    } else if (step.type === "mirror") {
      const resolved = await validateMirrorStep(step, label, manager, errors, i, reporter);
      if (resolved) resolvedSteps.push(resolved);
    }
  }

  // --- Step 4: Graph-based loop validation ---
  if (errors.length === 0) {
    const violations = validatePipelineGraph(resolvedSteps);
    for (const v of violations) {
      errors.push(
        `Invalid pipeline loop: exit node(s) [${v.offendingExitNodes.join(", ")}] ` +
          `in SCC [${v.sccNodes.join(", ")}] have outgoing edges outside the cycle ` +
          `but are not entry points. Transactions could flow out of this cycle in an ` +
          `uncontrolled way (entry nodes: [${v.entryNodes.join(", ")}]).`
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

async function getAccountsForBudget(
  alias: string,
  manager: BudgetManager
): Promise<ActualAccount[]> {
  await manager.open(alias);
  return (await actual.getAccounts()) as ActualAccount[];
}

/** Returns IDs of accounts in the currently-open budget that have bank sync enabled. */
async function getBankSyncedAccountIds(): Promise<Set<string>> {
  const { data } = (await aqlQuery(
    q("accounts")
      .select(["id", "account_sync_source"])
      .filter({ account_sync_source: { $ne: null } })
  )) as { data: Array<{ id: string; account_sync_source: string }> };
  return new Set(data.map((a) => a.id));
}

async function getCategoriesForBudget(
  alias: string,
  manager: BudgetManager
): Promise<ActualCategory[]> {
  await manager.open(alias);
  // getCategories returns a mix of category groups and leaf categories.
  // Leaf categories have a group_id field; groups do not.
  const all = await actual.getCategories();
  return (all as unknown[]).filter(
    (c): c is ActualCategory =>
      typeof c === "object" &&
      c !== null &&
      "group_id" in c &&
      typeof (c as Record<string, unknown>)["group_id"] === "string"
  );
}

function validateTagStrings(
  tags: string[],
  label: string,
  errors: string[]
): void {
  for (const tag of tags) {
    if (!tag.startsWith("#") || tag.length < 2) {
      errors.push(`${label}: tag "${tag}" must be a non-empty string starting with #`);
    }
  }
}

/** Returns IDs of accounts selected by the spec (all/on-budget/off-budget/IDs). */
function getSourceAccountIds(
  accounts: ActualAccount[],
  spec: AccountsSpec
): Set<string> {
  const selected = selectAccounts(accounts, spec);
  return new Set(selected.map((a) => a.id));
}

/** True if any destId is in the source set (overlap = invalid). */
function hasSourceDestOverlap(
  sourceIds: Set<string>,
  destIds: Set<string> | string
): boolean {
  const destSet = typeof destIds === "string" ? new Set([destIds]) : destIds;
  for (const id of destSet) {
    if (sourceIds.has(id)) return true;
  }
  return false;
}

async function validateSplitStep(
  step: SplitStep,
  label: string,
  manager: BudgetManager,
  errors: string[],
  stepIndex: number,
  reporter?: RunReporter
): Promise<ResolvedStep | null> {
  const accounts = await getAccountsForBudget(step.budget, manager);

  // Resolve source accounts (names -> IDs)
  const srcResult = resolveAccountsSpec(
    accounts,
    step.source.accounts,
    step.budget
  );
  if (!srcResult.ok) {
    errors.push(`${label}: ${srcResult.error}`);
    return null;
  }

  // Resolve destination accounts first (needed for broad-spec exclude)
  const destIds = new Set<string>();
  for (const [tag, action] of Object.entries(step.tags)) {
    const destResult = resolveAccountId(
      accounts,
      action.destination_account,
      step.budget
    );
    if (!destResult.ok) {
      errors.push(`${label}: tag "${tag}" ${destResult.error}`);
    } else {
      destIds.add(destResult.id);
      const destAccount = accounts.find((x) => x.id === destResult.id);
      if (destAccount?.closed && reporter) {
        reporter.warn("preflight.closedAccountInScope", {
          stepIndex,
          budget: step.budget,
          accountName: destAccount.name,
          accountId: destAccount.id,
        });
      }
    }
  }

  if (step.default) {
    const defResult = resolveAccountId(
      accounts,
      step.default.destination_account,
      step.budget
    );
    if (defResult.ok) {
      destIds.add(defResult.id);
    }
  }

  // Check for bank-synced destination accounts
  const bankSynced = await getBankSyncedAccountIds();
  for (const id of destIds) {
    if (bankSynced.has(id)) {
      const name = accounts.find((a) => a.id === id)?.name ?? id;
      errors.push(
        `${label}: destination account "${name}" has bank sync enabled — ` +
          `bank sync will overwrite imported_id and break ABMirror tracking. ` +
          `Unlink bank sync from this account in Actual before running ABMirror`
      );
    }
  }

  const isBroadSpec =
    step.source.accounts === "all" ||
    step.source.accounts === "on-budget" ||
    step.source.accounts === "off-budget";
  const excludeIds = isBroadSpec ? destIds : undefined;
  const selectedSourceAccounts = selectAccounts(accounts, srcResult.spec!, excludeIds);
  if (reporter && selectedSourceAccounts.length === 0) {
    reporter.warn("preflight.emptySourceScope", {
      stepIndex,
      stepType: "split",
      spec: step.source.accounts,
    });
  }
  // Split source and destination must not overlap (when explicit spec, dest in source = error)
  const sourceIds = new Set(selectedSourceAccounts.map((a) => a.id));
  if (hasSourceDestOverlap(sourceIds, destIds)) {
    errors.push(
      `${label}: split destination account is in source scope -- use explicit source accounts or exclude it`
    );
    return null;
  }

  return {
    type: "split",
    budgetAlias: step.budget,
    srcAccountIds: [...sourceIds],
    dstAccountIds: [...destIds],
  };
}

async function validateMirrorStep(
  step: MirrorStep,
  label: string,
  manager: BudgetManager,
  errors: string[],
  stepIndex: number,
  reporter?: RunReporter
): Promise<ResolvedStep | null> {
  const sourceAlias = step.source.budget;
  const destAlias = step.destination.budget;

  const sourceAccounts = await getAccountsForBudget(sourceAlias, manager);
  const destAccounts = await getAccountsForBudget(destAlias, manager);

  // Resolve source accounts (names -> IDs)
  const srcResult = resolveAccountsSpec(
    sourceAccounts,
    step.source.accounts,
    sourceAlias
  );
  if (!srcResult.ok) {
    errors.push(`${label}: ${srcResult.error}`);
    return null;
  }

  const selectedSourceAccounts = selectAccounts(sourceAccounts, srcResult.spec!);
  if (reporter && selectedSourceAccounts.length === 0) {
    reporter.warn("preflight.emptySourceScope", {
      stepIndex,
      stepType: "mirror",
      spec: step.source.accounts,
    });
  }

  // Resolve destination account
  const destResult = resolveAccountId(
    destAccounts,
    step.destination.account,
    destAlias
  );
  if (!destResult.ok) {
    errors.push(`${label}: ${destResult.error}`);
    return null;
  }
  const destAccount = destAccounts.find((x) => x.id === destResult.id);
  if (destAccount?.closed && reporter) {
    reporter.warn("preflight.closedAccountInScope", {
      stepIndex,
      budget: destAlias,
      accountName: destAccount.name,
      accountId: destAccount.id,
    });
  }

  // Check for bank-synced destination account
  const destBankSynced = await getBankSyncedAccountIds();
  if (destBankSynced.has(destResult.id)) {
    const name = destAccount?.name ?? destResult.id;
    errors.push(
      `${label}: destination account "${name}" has bank sync enabled — ` +
        `bank sync will overwrite imported_id and break ABMirror tracking. ` +
          `Unlink bank sync from this account in Actual before running ABMirror`
    );
  }

  // Same-budget: source accounts and destination must not overlap
  if (sourceAlias === destAlias) {
    const sourceIds = new Set(selectedSourceAccounts.map((a) => a.id));
    if (hasSourceDestOverlap(sourceIds, destResult.id)) {
      errors.push(
        `${label}: same-budget mirror where source accounts include destination account -- they must be distinct`
      );
      return null;
    }
  }

  // Validate category mappings
  if (step.categoryMapping && Object.keys(step.categoryMapping).length > 0) {
    const sourceCategories = await getCategoriesForBudget(sourceAlias, manager);
    const sourceCatIds = new Set(sourceCategories.map((c) => c.id));
    const destCategories = await getCategoriesForBudget(destAlias, manager);
    const destCatIds = new Set(destCategories.map((c) => c.id));

    for (const [srcCatId, destCatId] of Object.entries(step.categoryMapping)) {
      if (!sourceCatIds.has(srcCatId)) {
        errors.push(
          `${label}: categoryMapping source category "${srcCatId}" not found in budget "${sourceAlias}"`
        );
      }
      if (!destCatIds.has(destCatId)) {
        errors.push(
          `${label}: categoryMapping destination category "${destCatId}" not found in budget "${destAlias}"`
        );
      }
    }
  }

  return {
    type: "mirror",
    srcAlias: sourceAlias,
    srcAccountIds: selectedSourceAccounts.map((a) => a.id),
    dstAlias: destAlias,
    dstAccountId: destResult.id,
  };
}
