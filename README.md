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

lookbackDays: 60

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
| `lookbackDays` | How far back to scan transactions (default: 60) |
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
