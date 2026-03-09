---
name: ABMirror Transaction Sync
overview: Build a TypeScript tool ("ab-mirror") with two core components -- a generic transaction syncer/mirror and a tag-based transaction splitter -- orchestrated by a YAML-configured pipeline that processes steps in order across multiple Actual Budget files.
todos:
  - id: scaffold
    content: "Scaffold new repo: package.json, tsconfig.json, directory structure, dependencies (@actual-app/api, zod, yaml, commander)"
    status: pending
  - id: imported-id
    content: "Implement imported_id helpers: format, parse, and detect ABMirror IDs using Actual's Budget ID (not sync ID or alias)"
    status: pending
  - id: tag-parser
    content: "Implement tag parser: extract hashtags from notes field"
    status: pending
  - id: config
    content: Define YAML config schema with zod validation; secrets loaded from env vars (AB_MIRROR_SERVER_PASSWORD, AB_MIRROR_KEY_<ALIAS>), not from config file
    status: pending
  - id: selector
    content: "Build shared transaction source selector: account filtering (single, multiple, on/off-budget, all) + requiredTags (AND logic) + split subtransaction evaluation"
    status: pending
  - id: budget-manager
    content: "Build BudgetManager: wraps @actual-app/api budget open/close/sync lifecycle with caching"
    status: pending
  - id: syncer
    content: "Build syncer engine: source selection, destination write, imported_id tracking, invert mode, delete mode, category mapping, split transaction flattening, copy-mirrored toggle"
    status: pending
  - id: splitter
    content: "Build splitter engine: tag matching, amount transformation, destination write, split subtransaction handling"
    status: pending
  - id: preflight
    content: "Build preflight validator: download all budgets, resolve Budget IDs, validate account IDs, category mappings, same-budget constraints, tag syntax; collect and report all errors"
    status: pending
  - id: orchestrator
    content: "Build orchestrator: preflight validation, sequential step execution, budget lifecycle management, explicit sync steps, implicit final sync"
    status: pending
  - id: cli
    content: "Build CLI: config loading, dry-run mode, single-step mode, logging"
    status: pending
  - id: docker-k8s
    content: Create Dockerfile and example k8s CronJob manifest
    status: pending
  - id: tests
    content: Write unit tests for imported_id helpers, tag parser, syncer logic, splitter logic, and orchestrator step ordering
    status: pending
isProject: false
---

# ABMirror: Cross-Budget Transaction Sync and Split Tool

## Language Choice

TypeScript with strict mode. The `@actual-app/api` package is Node.js-only, so the interaction layer must be TypeScript regardless. Rather than adding a second language for a "core" that just shuffles data structures, we keep it all in TypeScript with strict compiler settings (`strict: true`, `noUncheckedIndexedAccess: true`) and thorough type definitions. This gives us type safety at the API boundary where correctness matters most.

## Project Structure (new standalone repo)

```
ab-mirror/
  package.json
  tsconfig.json
  src/
    index.ts                 # Library exports
    cli.ts                   # CLI entry point (one-shot binary)
    config/
      schema.ts              # YAML config types + validation (using zod)
      loader.ts              # Load and validate YAML config
    client/
      budget-manager.ts      # Manages budget open/close/sync lifecycle
    syncer/
      index.ts               # Transaction mirror/sync engine
      types.ts               # Syncer types
    splitter/
      index.ts               # Tag-based transaction splitter
      types.ts               # Splitter types
    orchestrator/
      index.ts               # Pipeline runner (executes steps in order)
      types.ts               # Step definitions
    selector/
      index.ts               # Shared transaction source selector (accounts + requiredTags)
      types.ts               # Selector types
    util/
      imported-id.ts          # ABMirror:<budget_alias>:<txid> helpers
      tags.ts                # Parse hashtags from notes field
  Dockerfile
  k8s/
    cronjob.yaml             # Example CronJob manifest
```

## Core Concepts

### Imported ID Format

All created/mirrored transactions are stamped with:

```
ABMirror:<budget_id>:<source_transaction_id>
```

- `ABMirror:` is the fixed prefix (used to detect "owned by us" vs "organic" transactions)
- `<budget_id>` is Actual's internal **Budget ID** (the `id` metadata pref, e.g., `My-Budget-a3f9c12`). This is NOT the Sync ID (groupId) and NOT the config alias. The Budget ID is stable for the life of the budget file -- it survives "Reset Sync" operations (which clear `groupId` but leave `id` intact). After downloading a budget, we read its Budget ID from `getBudgets()` and use that in all `imported_id` stamps.
- `<source_transaction_id>` is the `id` of the source transaction (or subtransaction)

The YAML config maps user-friendly aliases to **Sync IDs** (for download/connection). The `imported_id` uses the **Budget ID** (for stable identity). If a Sync ID changes after a re-upload, the user updates the config mapping, but all existing `imported_id` values remain valid because they reference the Budget ID which didn't change.

Helper functions: `formatImportedId(budgetId, txId)`, `parseImportedId(raw)`, `isABMirrorId(raw)`.

### How IDs Map

```
Config alias   -->  Sync ID (groupId)  -->  Budget ID (metadata 'id')
"nick-personal"    "xxxx-xxxx-xxxx"        "Nicks-Budget-a3f9c12"
```

- Config alias: human-readable key in YAML, used only in the config file
- Sync ID: used by `downloadBudget()` to fetch the budget from the server
- Budget ID: used in `imported_id` for stable cross-run identity; read from `getBudgets()` after download

### Budget Lifecycle Manager

Since `@actual-app/api` can only have one budget open at a time, a `BudgetManager` class wraps the lifecycle:

- `openBudget(syncId, { password? })` -- downloads/loads budget (uses `dataDir` cache on PVC to avoid full re-downloads)
- `syncAndClose()` -- syncs pending changes to server, closes budget
- `getCurrentBudgetId()` -- returns currently open budget's sync ID, or null
- Internally tracks which budgets have unsaved changes

The orchestrator uses this to minimize open/close cycles: if consecutive steps use the same budget, it stays open. If a step needs a different budget, the current one is synced and closed first.

### Tag Parsing

Tags are hashtags in the `notes` field. The parser extracts them:

- Input: `"Grocery store run #50/50 #food"`
- Output: `{ tags: ["#50/50", "#food"], cleanNotes: "Grocery store run" }`

Tags are matched case-insensitively.

---

## Shared: Transaction Source Selector

Both the syncer and splitter use the same source selection config format, extracted into a shared module (`src/selector/`):

```yaml
source:
  accounts: all                        # or "on-budget", "off-budget", ["id1", "id2"], or "id1"
  requiredTags: ["#joint"]             # optional; transaction must have ALL of these (AND logic)
```

- `accounts`: which accounts to scan. Accepts a single account ID string, an array of IDs, or the keywords `"all"`, `"on-budget"`, `"off-budget"`.
- `requiredTags`: optional list of hashtags (parsed from `notes`). A transaction must contain **all** listed tags to be considered. This acts as a scope/namespace mechanism -- e.g., requiring `#joint` prevents accidental matches on transactions that happen to contain `#50/50` for unrelated reasons.

For split transactions, each subtransaction is evaluated independently against the selector (its own notes, its own account via the parent).

---

## Component 1: Generic Transaction Syncer

### Purpose

Unidirectional mirror of transactions from one budget+account(s) to another budget+account.

### Source Selection

Uses the shared Transaction Source Selector (see above).

### Destination

Always a single `budget_alias` + `account_id`.

### Behavior

- **On first encounter** (no matching `imported_id` in destination): copy date, amount, payee_name, notes, category (mapped if mapping provided), cleared status. Set `imported_id` to `ABMirror:<source_budget_id>:<source_txid>` (using Actual's Budget ID, not the config alias or sync ID).
- **On subsequent runs** (matching `imported_id` exists): only update `date` and `amount`. All other fields are left as-is (the user may have recategorized in the destination).
- **Deletion** (toggle, default false): if a source transaction is removed, delete the mirrored transaction in the destination. Actual uses soft deletes (`tombstone = 1`) for normal deletion, and tombstoned rows persist indefinitely until a manual "Reset Sync." After a sync reset, tombstoned rows are permanently purged. The syncer handles both cases: on each run with delete enabled, it scans all mirrored transactions in the destination (those with `ABMirror:<source_budget_id>:*` imported_id) and checks if the referenced source transaction still exists and is not tombstoned. If the source is gone (tombstoned or purged), the mirrored transaction is deleted.
- **Invert mode** (toggle, default false): multiply amount by -1 when writing to destination.
- **Copy mirrored** (toggle, default false): by default, skip any source transaction whose `imported_id` starts with `ABMirror:`. When true, copy them anyway. Needed for multi-hop pipelines (e.g., step 8/9 in the user's pipeline where the source transactions are themselves mirrored copies).

### Split Transaction Handling

- If a source transaction is a split (parent + subtransactions):
  - If tag filtering is active: check each subtransaction individually. If a subtransaction's notes match the required tags, mirror just that subtransaction as a **flat standalone transaction** in the destination (using the subtransaction's amount).
  - If no tag filtering: mirror each subtransaction as a separate flat transaction. The parent is not mirrored (it has amount=0 and just groups the splits).
- The `imported_id` for a mirrored subtransaction uses the subtransaction's ID, not the parent's.

### Same-Budget Mode

If source and destination are the same budget, both `source.account` (single) and `destination.account` must be specified and must differ. The syncer validates this at startup and refuses to run if they could overlap.

### Category Mapping

Optional map of `{ [sourceCategoryId]: destinationCategoryId }`. Applied on creation only. If a source category has no mapping entry, the category is left null in the destination.

### Encrypted Budgets

Budget encryption passwords and the server password are **never stored in the YAML config**. The config file is treated as non-sensitive. Secrets are provided via environment variables using one of two patterns:

1. **Named env vars per budget**: `AB_MIRROR_KEY_<BUDGET_ALIAS>=<password>` (e.g., `AB_MIRROR_KEY_NICK_PERSONAL=secret123`). The alias is uppercased with hyphens replaced by underscores.
2. **Server password**: `AB_MIRROR_SERVER_PASSWORD=<password>`

In Kubernetes, these come from a Secret mounted as env vars. In Docker, via `--env-file` or `-e` flags. The config loader reads these from `process.env` at runtime -- no `${...}` substitution syntax in the YAML itself. The `budgets` section in YAML only contains the `syncId` and an optional `encrypted: true` flag to indicate the budget manager should look for the corresponding env var.

---

## Component 2: Tag-Based Transaction Splitter

### Purpose

Within a single budget, scan transactions for hashtags and create transformed copies in a specified destination account.

### Source Selection

Uses the shared Transaction Source Selector. The `requiredTags` on the source selector act as **global/scope tags** -- a transaction must have all of them to even be considered. Then the splitter checks for **action tags** (the transform-specific ones like `#50/50`).

For example, with `requiredTags: ["#joint"]` and action tag `#50/50`: a transaction must have BOTH `#joint` AND `#50/50` in its notes to be processed. A transaction with only `#50/50` (no `#joint`) is ignored. This prevents accidental matches.

### Configuration

```yaml
tags:
  "#50/50":
    multiplier: -0.5
    destination_account: britta-ar-account-id
  "#0/100":
    multiplier: -1.0
    destination_account: britta-ar-account-id
```

### Behavior

- Scans source transactions (filtered by the shared selector, including requiredTags).
- For each matching transaction, checks for action tags (`#50/50`, `#0/100`, etc.).
- For each match: creates a new transaction in the destination account with:
  - `amount = source.amount * multiplier`
  - `date`, `notes`, `category` copied from source (category kept 1:1 since same budget)
  - `payee_name` copied from source
  - `imported_id = ABMirror:<budget_id>:<source_txid>` (using Actual's Budget ID)
- On subsequent runs: only updates `date` and `amount` (using the current source amount * multiplier) if the source has changed.
- Split transactions: if a subtransaction has the action tag (and passes the global requiredTags check), only that subtransaction is processed (created as a flat transaction in the destination).
- If a transaction has multiple action tags (e.g., `#50/50 #0/100`), only the first matching tag config is applied. Tags are evaluated in config-definition order.

---

## Component 3: Pipeline Orchestrator

### Purpose

Execute a sequence of syncer and splitter steps in strict order, managing budget open/close lifecycle and explicit sync points.

### Step Types

1. `**split**` -- run the splitter on a budget
2. `**mirror**` -- run the syncer (source -> destination)
3. `**sync**` -- explicitly sync all modified budgets to the server

### Preflight Validation (implicit step 0)

Before any pipeline step executes, the orchestrator runs a full validation pass:

1. **Validate the yaml config** Make sure that internal references in the yaml are valid. Eg `pipeline.[].budget` exists in the `budgets` map and required fields exist etc.
2. **Download all budgets** referenced anywhere in the pipeline (source or destination of any step). This also validates that sync IDs are correct and encryption keys work (decryption failure = immediate abort).
3. **Resolve Budget IDs**: for each downloaded budget, read its Budget ID from `getBudgets()` and build the alias -> Budget ID mapping used for `imported_id`.
4. **Validate account IDs**: for each step, verify that every referenced `account_id` (source accounts, destination account) actually exists in the corresponding budget. Report the account name and budget alias for any mismatches.
5. **Validate category mappings**: if any step has a category mapping, verify all source and destination category IDs exist in their respective budgets.
6. **Validate same-budget constraints**: for mirror steps where source and destination are the same budget, verify source and destination accounts don't overlap.
7. **Validate tag syntax**: confirm required tags and action tags are non-empty strings starting with `#`.
8. **Report all errors at once**: collect all validation failures across all steps and report them together (don't fail on the first one). If any failures exist, abort without executing any steps.

This validation is also available as:

- `ab-mirror validate --config config.yaml` -- standalone validation command
- `ab-mirror run --config config.yaml --dry-run` -- runs validation, then simulates execution logging what each step would do (reads source transactions and reports counts/matches) without writing anything

### Execution Model

1. Steps execute strictly in definition order (never reordered).
2. The orchestrator tracks the currently open budget. If a step needs a budget that is not currently open, it syncs and closes the current one, then opens the needed one.
3. For cross-budget mirror steps: open source budget, read matching transactions into memory, sync+close, open destination budget, write mirrored transactions.
4. On a `sync` step: sync+close the current budget, then open+sync+close every other budget that has pending changes. This ensures all modifications are pushed to the server before subsequent steps read from those budgets.
5. After the final step: implicit sync+close of whatever budget is open (and any others with pending changes).

### Budget Open/Close Optimization

The orchestrator peeks ahead to avoid unnecessary cycles. For example, if steps 6 and 7 both operate within the joint budget, it stays open between them. But it never reorders steps to achieve this.

---

## YAML Configuration Format

```yaml
server:
  url: http://actual-budget:5006
  # Password provided via AB_MIRROR_SERVER_PASSWORD env var

dataDir: /data/ab-mirror              # PVC mount for cached budget DBs

budgets:
  nick-personal:
    syncId: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    encrypted: true                    # password via AB_MIRROR_KEY_NICK_PERSONAL env var
  britta-personal:
    syncId: "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy"
  joint:
    syncId: "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"

pipeline:
  # Step 1: Process joint-tagged transactions in nick's budget
  - type: split
    budget: nick-personal
    source:
      accounts: all
      requiredTags: ["#joint"]         # global scope tag -- must be present
    tags:
      "#50/50":
        multiplier: -0.5
        destination_account: britta-ar-account-id
      "#0/100":
        multiplier: -1.0
        destination_account: britta-ar-account-id

  # Step 2: Process joint-tagged transactions in britta's budget
  - type: split
    budget: britta-personal
    source:
      accounts: all
      requiredTags: ["#joint"]
    tags:
      "#50/50":
        multiplier: -0.5
        destination_account: nick-ar-account-id
      "#0/100":
        multiplier: -1.0
        destination_account: nick-ar-account-id

  # Step 3: Push changes to server before cross-budget mirroring
  - type: sync

  # Step 4: Mirror nick's AR entries up to joint budget
  - type: mirror
    source:
      budget: nick-personal
      accounts: [britta-ar-account-id]
    destination:
      budget: joint
      account: britta-ap-account-id
    delete: true

  # Step 5: Mirror britta's AR entries up to joint budget
  - type: mirror
    source:
      budget: britta-personal
      accounts: [nick-ar-account-id]
    destination:
      budget: joint
      account: nick-ap-account-id
    delete: true

  # Step 6: Invert britta AP -> nick AP inside joint budget
  - type: mirror
    source:
      budget: joint
      accounts: [britta-ap-account-id]
    destination:
      budget: joint
      account: nick-ap-account-id
    invert: true
    copyMirrored: true

  # Step 7: Invert nick AP -> britta AP inside joint budget
  - type: mirror
    source:
      budget: joint
      accounts: [nick-ap-account-id]
    destination:
      budget: joint
      account: britta-ap-account-id
    invert: true
    copyMirrored: true

  # Step 8: Mirror joint's britta AP back down to nick's personal
  - type: mirror
    source:
      budget: joint
      accounts: [britta-ap-account-id]
    destination:
      budget: nick-personal
      account: britta-ar-account-id
    copyMirrored: true

  # Step 9: Mirror joint's nick AP back down to britta's personal
  - type: mirror
    source:
      budget: joint
      accounts: [nick-ap-account-id]
    destination:
      budget: britta-personal
      account: nick-ar-account-id
    copyMirrored: true

  # Implicit final sync after all steps complete
```

## CLI Interface

```bash
# Validate config and all referenced budgets/accounts (no mutations)
ab-mirror validate --config config.yaml

# Run the full pipeline (preflight validation runs automatically first)
ab-mirror run --config config.yaml

# Dry run: validate + simulate execution, log what would happen (no mutations)
ab-mirror run --config config.yaml --dry-run

# Run a single step by index (for debugging; preflight still runs first)
ab-mirror run --config config.yaml --step 3
```

## Deployment

- **Dockerfile**: `node:22-alpine`, copy built JS, set entrypoint to `node dist/cli.js`
- **K8s CronJob**: runs every 15 minutes, mounts config YAML from a ConfigMap, PVC for `dataDir`
- **Secrets**: a Kubernetes Secret provides env vars:
  - `AB_MIRROR_SERVER_PASSWORD` -- Actual server password
  - `AB_MIRROR_KEY_NICK_PERSONAL` -- encryption key for nick's budget (if encrypted)
  - etc.
- The config YAML contains no secrets -- safe to store in git / ConfigMap

## Deduplication Efficiency

Each run only queries transactions from a rolling date window (configurable, default: last 60 days). The `imported_id` check is an in-memory Set lookup -- O(1) per transaction. For a typical household budget (~200 transactions/month across all accounts), each run processes ~400 transactions total in well under a second. The budget sync/download step dominates runtime (a few seconds), not the processing.