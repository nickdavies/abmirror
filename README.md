# ab-mirror

Cross-budget transaction sync and split tool for Actual Budget.

WARNING! This is still under development and not tested or known safe!

## Prerequisites

- **Node.js** (v22+ recommended)
- **Docker** (optional, for running a local Actual server or integration tests)
- An **Actual Budget** sync server (self-hosted or cloud)

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Create a config file

Create a YAML config file (e.g. `config.yaml`). Use `${VAR}` placeholders for secrets; they are substituted from environment variables at load time. See `config.yaml.example` for a template.

```yaml
server:
  url: "http://localhost:5006"   # or your Actual server URL
  password: "${AB_MIRROR_SERVER_PASSWORD}"

dataDir: "/tmp/ab-mirror-data"    # local dir for budget cache

budgets:
  main: { syncId: "<your-budget-sync-id>", encrypted: false }
  shared: { syncId: "<other-sync-id>", encrypted: true, key: "${AB_MIRROR_KEY_SHARED}" }

lookbackDays: 90

# Optional: push notifications via Pushover (for cron runs)
notify:
  onSuccess: false    # only notify on failure or warnings (default)
  pushover:
    user: "${AB_MIRROR_PUSHOVER_USER}"
    token: "${AB_MIRROR_PUSHOVER_TOKEN}"

pipeline:
  - type: split
    budget: main
    source:
      accounts: "all"             # or "on-budget", "off-budget", or account IDs
      requiredTags: ["#sync"]
    tags:
      "#50/50":
        multiplier: -0.5
        destination_account: "<account-id>"

  - type: mirror
    source: { budget: main, accounts: ["<account-id>"] }
    destination: { budget: shared, account: "<account-id>" }
```

### 4. Set environment variables

Secrets are provided via `${VAR}` substitution in the config. Set these before running:

```bash
export AB_MIRROR_SERVER_PASSWORD="your-actual-server-password"

# For encrypted budgets only (or use key in config with substitution):
export AB_MIRROR_KEY_SHARED="your-budget-encryption-key"
```

The budget key env var format is `AB_MIRROR_KEY_<ALIAS>` where the alias is uppercased (e.g. `shared` → `AB_MIRROR_KEY_SHARED`). You can also set `key: "${AB_MIRROR_KEY_SHARED}"` in the budget config.

**Pushover notifications (optional):** Set `AB_MIRROR_PUSHOVER_USER` and `AB_MIRROR_PUSHOVER_TOKEN` when using `notify.pushover` with `${VAR}` placeholders.

**Strict substitution:** Any `${VAR}` in the config must have the variable set and non-empty, or the tool throws immediately with a clear error.

### 5. Run commands

From the project root, use `npx` or `node dist/cli.js`:

```bash
# Validate config and budgets (no mutations)
npx ab-mirror validate --config config.yaml

# List account names and IDs (useful for filling in config)
npx ab-mirror list-accounts --config config.yaml

# Run the pipeline (dry-run first to simulate)
npx ab-mirror run --config config.yaml --dry-run

# Run for real
npx ab-mirror run --config config.yaml

# Run only a specific pipeline step (1-based index)
npx ab-mirror run --config config.yaml --step 1
```

## Running a local Actual server (for testing)

If you don't have an Actual server yet, run one with Docker:

```bash
docker run -d --rm -p 5006:5006 --name actual-server actualbudget/actual-server:latest
```

Or with docker compose (port 5007 to avoid conflicts with other services):

```bash
docker compose -f test/integration/docker-compose.yml up -d
# Server will be at http://localhost:5007
```

Then create a budget in the Actual web UI, enable sync, and use its sync ID in your config.

## Development

```bash
# Type check
npm run typecheck

# Unit tests
npm test

# Integration tests (starts Actual server in Docker, runs full pipeline)
npm run test:integration
```

## Config reference

| Field | Description |
|-------|-------------|
| `server.url` | Actual sync server URL |
| `server.password` | Optional. Server password. Use `${AB_MIRROR_SERVER_PASSWORD}` or leave unset to use env. |
| `dataDir` | Local directory for budget file cache |
| `budgets` | Map of alias → `{ syncId, encrypted?, key? }`. Use `key: "${AB_MIRROR_KEY_<ALIAS>}"` for encrypted budgets, or set env var. |
| `pipeline` | Array of split/mirror steps |
| `lookbackDays` | How far back to scan transactions (default: 90). **Warning:** transactions older than this window are invisible to ABMirror — they won't be created, updated, or deleted. If you shorten this value, mirror copies of older transactions become unmanaged (not deleted, just ignored). |
| `notify` | Optional push notifications (Pushover). `onSuccess: false` (default) = only notify on failure or warnings. Use `${AB_MIRROR_PUSHOVER_USER}` and `${AB_MIRROR_PUSHOVER_TOKEN}` for credentials. |

**Notify**: When configured, sends run summaries and non-fatal warnings (e.g. multi-tag skipped, closed accounts in scope) to Pushover. The full report is always logged to stdout; Pushover messages may be truncated with a pointer to check logs.

**Split step**: Splits tagged transactions from source accounts into destination accounts based on tag multipliers. Tags are always exclusive: when a transaction matches multiple action tags, it is skipped (reported via notifier). For multiple destinations, add multiple split steps.

**Mirror step**: Copies transactions from source budget/accounts to a destination budget/account. Options: `invert`, `delete`, `categoryMapping`.

## Known limitation: Config changes can strand transactions

When you **change the config** so a destination is no longer in the step (e.g. change `#50/50` from `JointAccount` to `SplitAccount` and remove `JointAccount` from the config), we stop reading from the old destination. Transactions there become **stranded**—they remain but are no longer managed.

This applies only to **config changes**, not to **transaction content changes**. If a user changes a transaction's tag from `#50/50` to `#0/100`, we read from both destinations and correctly delete from the old one and add to the new one.

### Migration pattern for config changes

When changing destinations in config, use a stepwise migration:

1. Add a temporary tag mapping to keep the old account in scope: `"#legacy" -> old_account`
2. Run the pipeline. We read from both old and new destinations; stranded transactions in the old account are deleted (they are not in the desired set).
3. Remove the `#legacy` entry from config.

You control `lookbackDays` for how far back to clean—use a shorter value for recent-only cleanup, or the full value for a complete migration.

## Destination accounts should be dedicated to ABMirror

**Strongly recommended: use dedicated, empty accounts as ABMirror destinations.** Do not point ABMirror at accounts that contain manually-entered or bank-synced transactions. When a destination account contains only ABMirror-managed transactions, recovery from any misconfiguration is simple: delete all transactions in the account and re-run ABMirror with a long `lookbackDays` to recreate them.

If you mix ABMirror transactions with real transactions in the same account, you lose this safety net — there is no way to distinguish which transactions ABMirror created vs. which you entered manually, and a bulk delete becomes destructive.

## Known limitation: Bank sync can clobber ABMirror's `imported_id`

ABMirror tracks its transactions via `imported_id` (stored as `financial_id` in Actual's SQLite DB). If a destination account has bank sync enabled (GoCardless, SimpleFin, or Pluggy.ai), the bank sync process can overwrite or null out the `imported_id` that ABMirror set, breaking ABMirror's ability to match, update, and delete its own transactions.

**How it happens:** Actual's bank sync reconciliation matches incoming bank transactions against existing ones by date/amount/payee. When it updates a matched transaction, it replaces `imported_id` with the bank's value (or `null`), destroying ABMirror's `ABMirror:<budgetId>:<txId>` identifier.

### Preflight protection

ABMirror checks every destination account for bank sync at startup. If any destination has bank sync enabled, **the pipeline refuses to run** with an error identifying the account. This prevents ABMirror from writing to an account where its data would be corrupted.

However, if you enable bank sync on an existing destination account *between* ABMirror runs, bank sync may corrupt transactions before ABMirror's next run catches it. ABMirror cannot prevent this — it only detects it.

### Recovery

If bank sync has already run against a destination account:

1. Unlink bank sync from the account in Actual's UI.
2. Delete all transactions in the destination account (this is safe if you followed the recommendation above to keep destination accounts dedicated to ABMirror).
3. Re-run ABMirror with a `lookbackDays` value large enough to cover the full history. ABMirror will recreate all transactions with correct `imported_id` values.

### Technical details

Actual stores `account_sync_source` on each account (`'simpleFin'`, `'goCardless'`, or `'pluggyai'` when linked, `null` otherwise). This is not exposed by `getAccounts()` but is queryable via the AQL API:

```typescript
import { q, aqlQuery } from "@actual-app/api";

const { data } = await aqlQuery(
  q("accounts")
    .select(["id", "name", "account_sync_source"])
    .filter({ account_sync_source: { $ne: null } })
);
```
