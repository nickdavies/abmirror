# YAML-Driven Integration Test Cases

Each subdirectory here is one test case, automatically discovered and run by Vitest when you run `npm test`.

## Directory layout

```
cases/
  <case-name>/
    before.yaml   — initial state of all relevant budgets/accounts/transactions
    pipeline.yaml — pipeline steps (mirror / split) to run
    after.yaml    — expected settled state after the pipeline converges
```

Any directory containing all three files is treated as a case. Add a new directory to add a new test.

---

## Fixture format

### `before.yaml` / `after.yaml`

```yaml
budgets:
  src:                        # budget alias (matches pipeline.yaml references)
    accounts:
      checking:               # account name (used in pipeline.yaml as account ref)
        offbudget: true       # optional; omit if false (default)
        closed: true          # optional; omit if false (default)
        transactions:
          - id: TX-1          # stable user-defined ID (see Transaction IDs below)
            date: "2025-01-15"
            amount: -10000    # in cents (negative = expense)
            payee_name: Coffee
            notes: null
            category: null
            cleared: null
            imported_id: null
            subs: []          # subtransactions (same fields, no nested subs)
  dst:
    accounts:
      recv:
        transactions: []
```

### `pipeline.yaml`

Uses the standard ab-mirror step format, but **account references must be account names** (matching the keys in `before.yaml`), not UUIDs:

```yaml
pipeline:
  - type: mirror
    source:
      budget: src
      accounts: all           # or "on-budget", "off-budget", or [accountName, ...]
    destination:
      budget: dst
      account: recv           # account name
    invert: false
    delete: false

  - type: split
    budget: src
    source:
      accounts: all
      requiredTags: ["#joint"]
    tags:
      "#50/50":
        multiplier: -0.5
        destination_account: recv   # account name
```

---

## Transaction IDs

Transaction IDs in `before.yaml` (e.g. `TX-1`, `TX-2`, `TX-3-SUB-1`) are **stable user-defined names**. They are used directly as runtime IDs during import, so `imported_id` values in `after.yaml` always reference the same IDs that appear in `before.yaml`.

New transactions created by the engine during a test run are assigned fresh `TX-N` IDs starting from `max(existing N) + 1`.

**`imported_id` format** — ABMirror references use budget aliases (not UUIDs): `"ABMirror:<budgetAlias>:<txId>"`. Since `imported_id` always points to the root source transaction, the `<txId>` is always an ID from `before.yaml`.

Transaction order within each account does not matter — the roundtrip test compares by content, not YAML ordering.

---

## Settling algorithm

The test harness runs the full pipeline **N+1 times** (N = number of pipeline steps) to propagate multi-step dependencies, then once more to assert **no changes** (idempotency check). If the final round produces changes, the test fails with a "did not converge / possible oscillating loop" message.

For a single-step pipeline: 2 propagation rounds + 1 idempotency round = 3 total.  
For a 3-step pipeline: 4 + 1 = 5 total rounds.

---

## How to generate cases from localdev

```bash
cd localdev

# 1. Bootstrap the server with your real budget zips
./bootstrap.sh nick.zip britta.zip joint.zip

# 2. Capture the before state
npx tsx snapshot.ts --out before.yaml

# 3. Run the pipeline you want to test
./run-pipeline.sh --pipeline pipelines/my-pipeline.yaml

# 4. Capture the after state
npx tsx snapshot.ts --out after.yaml

# 5. Create the test case
CASE=my-case
mkdir -p ../test/integration/cases/$CASE
cp before.yaml after.yaml ../test/integration/cases/$CASE/
cp pipelines/my-pipeline.yaml ../test/integration/cases/$CASE/pipeline.yaml

# 6. Verify it passes
cd .. && npm test
```

The snapshot CLI reads `localdev/config.yaml` by default. Pass `--config PATH` to override, and `--budgets alias1,alias2` to snapshot only specific budgets.

---

## Roundtrip test

Separately from the per-case assertions, there is a `fixture roundtrip` test that verifies `importFixtureToRuntime(before.yaml) → exportRuntimeToFixture` produces the same transactions with the same fields for every case. This catches data corruption or loss in the import/export helpers. The comparison is order-independent — transaction ordering in the YAML does not matter.
