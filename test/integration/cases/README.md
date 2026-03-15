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
          - id: TX-1          # placeholder (see ID normalization below)
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

## ID normalization

Placeholder IDs (`TX-1`, `TX-2`, `TX-3-SUB-1`, …) are assigned by sorting all **visible** (non-tombstoned, non-child) top-level transactions globally in each snapshot by:

```
(budgetAlias, accountName, date, notes ?? '', payee_name ?? ''), then by amount
```

Transactions are numbered TX-1, TX-2, … in that order. Subtransactions within a parent `TX-N` are numbered `TX-N-SUB-1`, `TX-N-SUB-2`, ….

**`imported_id` rewriting** — ABMirror references (`ABMirror:<budgetId>:<txUuid>`) are rewritten to use:
- the budget **alias** instead of its internal UUID
- the transaction **placeholder** (TX-N) instead of its UUID

So `"ABMirror:budget-src:test-tx-1"` becomes `"ABMirror:src:TX-3"`.

**Important**: fixture files must list transactions in canonical sort order (earliest date first within each account, budgets in alphabetical order). If transactions are out of order the roundtrip test will fail and alert you.

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

Separately from the per-case assertions, there is a `fixture roundtrip` test that verifies `importFixtureToRuntime(before.yaml) → exportRuntimeToFixture` equals the original `before.yaml` for every case. This ensures the import/export helpers are symmetric and the fixture is in canonical form. If this fails, check that your transactions are listed in the correct sort order.
