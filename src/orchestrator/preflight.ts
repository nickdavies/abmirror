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
import type { Config, MirrorStep, SplitStep } from "../config/schema";
import { selectAccounts } from "../selector/index";
import type { BudgetManager } from "../client/budget-manager";
import type { ActualAccount, ActualCategory } from "../selector/types";
import {
  checkDuplicateNames,
  formatDuplicateErrorForUser,
  resolveAccountsSpec,
  resolveAccountId,
} from "../util/account-resolver";

export interface PreflightResult {
  ok: boolean;
  errors: string[];
}

export async function runPreflight(
  config: Config,
  manager: BudgetManager
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
      errors.push(`Failed to download budget "${alias}": ${String(err)}`);
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
  for (let i = 0; i < config.pipeline.length; i++) {
    const step = config.pipeline[i]!;
    const label = `step[${i}] (${step.type})`;

    if (step.type === "split") {
      await validateSplitStep(step, label, manager, errors);
    } else if (step.type === "mirror") {
      await validateMirrorStep(step, label, manager, errors);
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

async function validateSplitStep(
  step: SplitStep,
  label: string,
  manager: BudgetManager,
  errors: string[]
): Promise<void> {
  const accounts = await getAccountsForBudget(step.budget, manager);

  // Resolve source accounts (names -> IDs)
  const srcResult = resolveAccountsSpec(
    accounts,
    step.source.accounts,
    step.budget
  );
  if (!srcResult.ok) {
    errors.push(`${label}: ${srcResult.error}`);
    return;
  }

  // Validate destination accounts referenced in tag actions
  for (const [tag, action] of Object.entries(step.tags)) {
    const destResult = resolveAccountId(
      accounts,
      action.destination_account,
      step.budget
    );
    if (!destResult.ok) {
      errors.push(`${label}: tag "${tag}" ${destResult.error}`);
    }
  }
}

async function validateMirrorStep(
  step: MirrorStep,
  label: string,
  manager: BudgetManager,
  errors: string[]
): Promise<void> {
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
    return;
  }

  // Resolve destination account
  const destResult = resolveAccountId(
    destAccounts,
    step.destination.account,
    destAlias
  );
  if (!destResult.ok) {
    errors.push(`${label}: ${destResult.error}`);
    return;
  }

  // Same-budget: source accounts and destination must not overlap
  if (sourceAlias === destAlias) {
    const selectedSrcAccounts = selectAccounts(
      sourceAccounts,
      srcResult.spec!
    );
    const selectedSrcIds = new Set(selectedSrcAccounts.map((a) => a.id));
    if (selectedSrcIds.has(destResult.id)) {
      errors.push(
        `${label}: same-budget mirror where source accounts include destination account -- they must be distinct`
      );
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
}
