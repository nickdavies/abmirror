import * as actual from "@actual-app/api";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";

// ─── Types ────────────────────────────────────────────────────────────────────

type BudgetAlias = "A" | "B" | "Joint";
type AccountName =
  | "Checking"
  | "Joint"
  | "Recv"
  | "Savings"
  | "AIndv"
  | "BIndv"
  | "JointExpenses"
  | "PayA"
  | "PayB";

type TxLike = {
  id: string;
  date: string;
  amount: number;
  payee?: string | null;
  payee_name?: string | null;
  notes?: string | null;
  category?: string | null;
  cleared?: boolean | null;
  imported_id?: string | null;
  tombstone?: boolean;
  is_child?: boolean;
  is_parent?: boolean;
  parent_id?: string | null;
  account?: string;
  subtransactions?: TxLike[];
};

type SnapshotTx = {
  id: string;
  date: string;
  amount: number;
  payee_name: string | null;
  notes: string | null;
  category: string | null;
  cleared: boolean | null;
  imported_id: string | null;
  is_parent: boolean;
  subs: Array<{
    id: string;
    amount: number;
    notes: string | null;
    date: string;
    imported_id: string | null;
  }>;
};

type BudgetFixture = {
  syncId: string;
  accountIds: Partial<Record<AccountName, string>>;
  categoryIds: Record<string, string>;
};

type Fixture = {
  rootDir: string;
  configPath: string;
  assertDataDir: string;
  binaryDataDir: string;
  budgets: Record<BudgetAlias, BudgetFixture>;
};

type AccountRef = { alias: BudgetAlias; account: AccountName };

// ─── Constants ────────────────────────────────────────────────────────────────

const SERVER_URL = "http://localhost:5007";
const SERVER_PASSWORD = "test";
const TX_START = "2000-01-01";
const TX_END = "2100-01-01";
const PRESERVED_NOTES = "IT_preserved_user_notes";

const MARKERS = {
  aRum: "IT_a_rum",
  aGroceriesParent: "IT_a_groceries_parent",
  aGroceriesSub1: "IT_a_groceries_sub1",
  aGroceriesSub2: "IT_a_groceries_sub2",
  aPersonal: "IT_a_personal",
  bGroceries: "IT_b_groceries",
  bPersonal: "IT_b_personal",
  jointGames: "IT_joint_games",
  jointPersonalB: "IT_joint_personal_b",
} as const;

const ALL_ACCOUNTS: AccountRef[] = [
  { alias: "A", account: "Checking" },
  { alias: "A", account: "Recv" },
  { alias: "A", account: "Joint" },
  { alias: "A", account: "Savings" },
  { alias: "B", account: "Checking" },
  { alias: "B", account: "Recv" },
  { alias: "B", account: "Joint" },
  { alias: "B", account: "Savings" },
  { alias: "Joint", account: "AIndv" },
  { alias: "Joint", account: "BIndv" },
  { alias: "Joint", account: "Checking" },
  { alias: "Joint", account: "JointExpenses" },
  { alias: "Joint", account: "PayA" },
  { alias: "Joint", account: "PayB" },
];

// ─── Assertion helpers ────────────────────────────────────────────────────────

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function rootDir(): string {
  return path.resolve(__dirname, "..", "..");
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function visibleTxs(txs: TxLike[]): TxLike[] {
  return txs.filter((t) => !t.tombstone && !t.is_child);
}

function txHasMarker(tx: TxLike, marker: string): boolean {
  return Boolean(tx.notes?.includes(marker) || tx.payee_name?.includes(marker));
}

function getOneByMarker(txs: TxLike[], marker: string, context: string): TxLike {
  const matches = visibleTxs(txs).filter((tx) => txHasMarker(tx, marker));
  assert(
    matches.length === 1,
    `${context}: expected exactly one match for marker ${marker}, got ${matches.length}`
  );
  return matches[0];
}

function normalizeTx(tx: TxLike): SnapshotTx {
  return {
    id: tx.id,
    date: tx.date,
    amount: tx.amount,
    payee_name: tx.payee_name ?? null,
    notes: tx.notes ?? null,
    category: tx.category ?? null,
    cleared: tx.cleared ?? null,
    imported_id: tx.imported_id ?? null,
    is_parent: Boolean(tx.is_parent),
    subs: (tx.subtransactions ?? [])
      .map((sub) => ({
        id: sub.id,
        amount: sub.amount,
        notes: sub.notes ?? null,
        date: sub.date,
        imported_id: sub.imported_id ?? null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function normalizeAccountSnapshot(txs: TxLike[]): SnapshotTx[] {
  return visibleTxs(txs)
    .map(normalizeTx)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function toContentSnapshot(
  txs: SnapshotTx[]
): Array<Omit<SnapshotTx, "id"> & { subs: Array<Omit<SnapshotTx["subs"][0], "id">> }> {
  return txs
    .map((t) => {
      const { id: _id, ...rest } = t;
      return {
        ...rest,
        subs: t.subs.map(({ id: _sid, ...s }) => s),
      };
    })
    .sort((a, b) =>
      `${a.amount}:${a.date}:${a.notes ?? ""}`.localeCompare(
        `${b.amount}:${b.date}:${b.notes ?? ""}`
      )
    );
}

function assertContentSnapshotsEqual(
  actual: SnapshotTx[],
  expected: SnapshotTx[],
  context: string
): void {
  const actualContent = JSON.stringify(toContentSnapshot(actual));
  const expectedContent = JSON.stringify(toContentSnapshot(expected));
  assert(
    actualContent === expectedContent,
    `${context}: content mismatch\nexpected=${expectedContent}\nactual=${actualContent}`
  );
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function withApi<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  await actual.init({ dataDir, serverURL: SERVER_URL, password: SERVER_PASSWORD });
  try {
    return await fn();
  } finally {
    await actual.shutdown();
  }
}

async function getSyncIdByBudgetName(name: string): Promise<string> {
  const budgets = await actual.getBudgets();
  const found = budgets.find((b) => b.name === name && Boolean(b.groupId));
  assert(found?.groupId, `Could not resolve syncId for budget "${name}"`);
  return found.groupId;
}

async function openBudget(fixture: Fixture, alias: BudgetAlias): Promise<void> {
  await actual.downloadBudget(fixture.budgets[alias].syncId);
}

async function getAccountTxs(
  fixture: Fixture,
  alias: BudgetAlias,
  accountName: AccountName
): Promise<TxLike[]> {
  await openBudget(fixture, alias);
  const accountId = fixture.budgets[alias].accountIds[accountName];
  assert(accountId, `Missing account "${accountName}" for budget "${alias}"`);
  return (await actual.getTransactions(accountId, TX_START, TX_END)) as TxLike[];
}

/** Capture normalized snapshots for all accounts, grouped by budget to minimize opens. */
async function captureAllSnapshots(
  fixture: Fixture
): Promise<Map<string, SnapshotTx[]>> {
  return withApi(fixture.assertDataDir, async () => {
    const map = new Map<string, SnapshotTx[]>();
    for (const alias of ["A", "B", "Joint"] as BudgetAlias[]) {
      await openBudget(fixture, alias);
      for (const ref of ALL_ACCOUNTS.filter((a) => a.alias === alias)) {
        const accountId = fixture.budgets[alias].accountIds[ref.account];
        assert(accountId, `Missing account "${ref.account}" for budget "${alias}"`);
        const txs = (await actual.getTransactions(
          accountId,
          TX_START,
          TX_END
        )) as TxLike[];
        map.set(`${alias}:${ref.account}`, normalizeAccountSnapshot(txs));
      }
    }
    return map;
  });
}

function runPipeline(fixture: Fixture): void {
  execSync(`node dist/cli.js run --config "${fixture.configPath}"`, {
    cwd: fixture.rootDir,
    stdio: "inherit",
    env: { ...process.env },
  });
}

function assertCount(txs: TxLike[], expected: number, context: string): void {
  const count = visibleTxs(txs).length;
  assert(count === expected, `${context}: expected ${expected} visible txs, got ${count}`);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<Fixture> {
  const repoRoot = rootDir();
  const assertDataDir = makeTempDir("abm-it-assert-");
  const binaryDataDir = makeTempDir("abm-it-binary-");
  const bootstrapDataDir = makeTempDir("abm-it-bootstrap-");
  const configPath = path.join(repoRoot, "test/e2e/.tmp-config.yaml");
  mkdirSync(path.dirname(configPath), { recursive: true });

  const budgets: Record<BudgetAlias, BudgetFixture> = {
    A: { syncId: "", accountIds: {}, categoryIds: {} },
    B: { syncId: "", accountIds: {}, categoryIds: {} },
    Joint: { syncId: "", accountIds: {}, categoryIds: {} },
  };

  await withApi(bootstrapDataDir, async () => {
    // ─── Budget A ──────────────────────────────────────────────────────
    await actual.runImport("A", async () => {
      const checking = await actual.createAccount({ name: "Checking" }, 0);
      const joint = await actual.createAccount({ name: "Joint" }, 0);
      const recv = await actual.createAccount({ name: "Recv" }, 0);
      const savings = await actual.createAccount({ name: "Savings" }, 0);
      budgets.A.accountIds = {
        Checking: checking,
        Joint: joint,
        Recv: recv,
        Savings: savings,
      };

      const groupId = await actual.createCategoryGroup({ name: "Expenses" });
      const rum = await actual.createCategory({ name: "Rum", group_id: groupId });
      const groceries = await actual.createCategory({
        name: "Groceries",
        group_id: groupId,
      });
      budgets.A.categoryIds = { Rum: rum, Groceries: groceries };

      await actual.addTransactions(checking, [
        {
          date: "2025-01-15",
          amount: -16000,
          payee_name: "Total Bev",
          notes: `#joint #50/50 Rum ${MARKERS.aRum}`,
          category: rum,
        },
        {
          date: "2025-01-20",
          amount: -8000,
          notes: `part joint part 100% partner ${MARKERS.aGroceriesParent}`,
          subtransactions: [
            {
              amount: -6000,
              notes: `#joint #50/50 shared part of groceries ${MARKERS.aGroceriesSub1}`,
              category: groceries,
            },
            {
              amount: -2000,
              notes: `#joint #0/100 spent $20 on redbull for partner ${MARKERS.aGroceriesSub2}`,
            },
          ],
        },
        {
          date: "2025-01-20",
          amount: -4000,
          notes: `personal ${MARKERS.aPersonal}`,
        },
      ]);
    });
    budgets.A.syncId = await getSyncIdByBudgetName("A");

    // ─── Budget B ──────────────────────────────────────────────────────
    await actual.runImport("B", async () => {
      const checking = await actual.createAccount({ name: "Checking" }, 0);
      const joint = await actual.createAccount({ name: "Joint" }, 0);
      const recv = await actual.createAccount({ name: "Recv" }, 0);
      const savings = await actual.createAccount({ name: "Savings" }, 0);
      budgets.B.accountIds = {
        Checking: checking,
        Joint: joint,
        Recv: recv,
        Savings: savings,
      };

      const groupId = await actual.createCategoryGroup({ name: "Expenses" });
      const groceries = await actual.createCategory({
        name: "Groceries",
        group_id: groupId,
      });
      budgets.B.categoryIds = { Groceries: groceries };

      await actual.addTransactions(checking, [
        {
          date: "2025-01-18",
          amount: -10000,
          payee_name: "King Soopers",
          notes: `#joint #50/50 ${MARKERS.bGroceries}`,
          category: groceries,
        },
        {
          date: "2025-01-22",
          amount: -3500,
          notes: MARKERS.bPersonal,
        },
      ]);
    });
    budgets.B.syncId = await getSyncIdByBudgetName("B");

    // ─── Budget Joint ──────────────────────────────────────────────────
    await actual.runImport("Joint", async () => {
      const aIndv = await actual.createAccount({ name: "AIndv" }, 0);
      const bIndv = await actual.createAccount({ name: "BIndv" }, 0);
      const checking = await actual.createAccount({ name: "Checking" }, 0);
      const jointExpenses = await actual.createAccount(
        { name: "JointExpenses", offbudget: true },
        0
      );
      const payA = await actual.createAccount({ name: "PayA" }, 0);
      const payB = await actual.createAccount({ name: "PayB" }, 0);
      budgets.Joint.accountIds = {
        AIndv: aIndv,
        BIndv: bIndv,
        Checking: checking,
        JointExpenses: jointExpenses,
        PayA: payA,
        PayB: payB,
      };

      const groupId = await actual.createCategoryGroup({ name: "Expenses" });
      const games = await actual.createCategory({ name: "Games", group_id: groupId });
      const misc = await actual.createCategory({ name: "Misc", group_id: groupId });
      const groceriesJoint = await actual.createCategory({
        name: "GroceriesJoint",
        group_id: groupId,
      });
      budgets.Joint.categoryIds = {
        Games: games,
        Misc: misc,
        GroceriesJoint: groceriesJoint,
      };

      await actual.addTransactions(checking, [
        {
          date: "2025-01-25",
          amount: -30000,
          payee_name: "Total Escape Games",
          notes: MARKERS.jointGames,
          category: games,
        },
        {
          date: "2025-01-26",
          amount: -4000,
          payee_name: "United Airlines",
          notes: `#personal_b ${MARKERS.jointPersonalB}`,
          category: misc,
        },
      ]);
    });
    budgets.Joint.syncId = await getSyncIdByBudgetName("Joint");

    // ─── Fix subtransaction payees on Budget A ─────────────────────────
    await actual.downloadBudget(budgets.A.syncId);
    const aTxs = (await actual.getTransactions(
      budgets.A.accountIds.Checking!,
      TX_START,
      TX_END
    )) as TxLike[];

    const parent = aTxs.find((t) => t.notes?.includes(MARKERS.aGroceriesParent));
    assert(parent, `Could not find parent by marker ${MARKERS.aGroceriesParent}`);
    assert(parent.subtransactions?.length, "Parent has no subtransactions");
    const sub1 = parent.subtransactions!.find((t) =>
      t.notes?.includes(MARKERS.aGroceriesSub1)
    );
    const sub2 = parent.subtransactions!.find((t) =>
      t.notes?.includes(MARKERS.aGroceriesSub2)
    );
    assert(sub1, `Could not find sub1 by marker ${MARKERS.aGroceriesSub1}`);
    assert(sub2, `Could not find sub2 by marker ${MARKERS.aGroceriesSub2}`);

    // Fix subtransaction payees and amounts. addTransactions stores sub amounts
    // but they may be lost after sync; updateTransaction ensures they persist.
    const costcoUpperId = await actual.createPayee({ name: "Costco" });
    const costcoLowerId = await actual.createPayee({ name: "costco" });
    await actual.updateTransaction(sub1.id, {
      payee: costcoUpperId,
      amount: -6000,
      category: budgets.A.categoryIds.Groceries,
    } as any);
    await actual.updateTransaction(sub2.id, {
      payee: costcoLowerId,
      amount: -2000,
    } as any);
    await actual.sync();
  });

  // ─── Write pipeline config ──────────────────────────────────────────────────

  const catA = budgets.A.categoryIds;
  const catB = budgets.B.categoryIds;
  const catJ = budgets.Joint.categoryIds;

  const config = {
    server: { url: SERVER_URL, password: SERVER_PASSWORD },
    dataDir: binaryDataDir,
    budgets: {
      A: { syncId: budgets.A.syncId, encrypted: false },
      B: { syncId: budgets.B.syncId, encrypted: false },
      Joint: { syncId: budgets.Joint.syncId, encrypted: false },
    },
    lookbackDays: 3650,
    maxChangesPerStep: 0,
    pipeline: [
      // Step 1: Split A:Checking (#joint) → A:Recv
      {
        type: "split",
        budget: "A",
        source: { accounts: ["Checking"], requiredTags: ["#joint"] },
        tags: {
          "#50/50": { multiplier: -0.5, destination_account: "Recv" },
          "#0/100": { multiplier: -1, destination_account: "Recv" },
        },
        delete: true,
      },
      // Step 2: Split B:Checking (#joint) → B:Recv
      {
        type: "split",
        budget: "B",
        source: { accounts: ["Checking"], requiredTags: ["#joint"] },
        tags: {
          "#50/50": { multiplier: -0.5, destination_account: "Recv" },
        },
        delete: true,
      },
      // Step 3: Split Joint:Checking → JointExpenses (default: 50%)
      {
        type: "split",
        budget: "Joint",
        source: { accounts: ["Checking"] },
        tags: {},
        default: { multiplier: 0.5, destination_account: "JointExpenses" },
        delete: true,
      },
      // Step 4: Split Joint:Checking → PayA/PayB (#personal charge)
      {
        type: "split",
        budget: "Joint",
        source: { accounts: ["Checking"] },
        tags: {
          "#personal_a": { multiplier: 0.5, destination_account: "PayA" },
          "#personal_b": { multiplier: 0.5, destination_account: "PayB" },
        },
        delete: true,
      },
      // Step 5: Split Joint:Checking → PayB/PayA (#personal offset)
      {
        type: "split",
        budget: "Joint",
        source: { accounts: ["Checking"] },
        tags: {
          "#personal_a": { multiplier: -0.5, destination_account: "PayB" },
          "#personal_b": { multiplier: -0.5, destination_account: "PayA" },
        },
        delete: true,
      },
      // Step 6: Mirror A:Checking (#joint,#50/50) → Joint:AIndv
      {
        type: "mirror",
        source: {
          budget: "A",
          accounts: ["Checking"],
          requiredTags: ["#joint", "#50/50"],
        },
        destination: { budget: "Joint", account: "AIndv" },
        delete: true,
      },
      // Step 7: Mirror B:Checking (#joint,#50/50) → Joint:BIndv
      {
        type: "mirror",
        source: {
          budget: "B",
          accounts: ["Checking"],
          requiredTags: ["#joint", "#50/50"],
        },
        destination: { budget: "Joint", account: "BIndv" },
        delete: true,
      },
      // Step 8: Mirror A:Recv → Joint:PayA
      {
        type: "mirror",
        source: { budget: "A", accounts: ["Recv"] },
        destination: { budget: "Joint", account: "PayA" },
        categoryMapping: { [catA.Groceries]: catJ.GroceriesJoint },
        delete: true,
      },
      // Step 9: Mirror B:Recv → Joint:PayB
      {
        type: "mirror",
        source: { budget: "B", accounts: ["Recv"] },
        destination: { budget: "Joint", account: "PayB" },
        categoryMapping: { [catB.Groceries]: catJ.GroceriesJoint },
        delete: true,
      },
      // Step 10: Mirror Joint:PayB → Joint:PayA (invert)
      {
        type: "mirror",
        source: { budget: "Joint", accounts: ["PayB"] },
        destination: { budget: "Joint", account: "PayA" },
        invert: true,
        delete: true,
      },
      // Step 11: Mirror Joint:PayA → Joint:PayB (invert)
      {
        type: "mirror",
        source: { budget: "Joint", accounts: ["PayA"] },
        destination: { budget: "Joint", account: "PayB" },
        invert: true,
        delete: true,
      },
      // Step 12: Mirror Joint:PayA → A:Recv
      {
        type: "mirror",
        source: { budget: "Joint", accounts: ["PayA"] },
        destination: { budget: "A", account: "Recv" },
        categoryMapping: { [catJ.GroceriesJoint]: catA.Groceries },
        delete: true,
      },
      // Step 13: Mirror Joint:PayB → B:Recv
      {
        type: "mirror",
        source: { budget: "Joint", accounts: ["PayB"] },
        destination: { budget: "B", account: "Recv" },
        categoryMapping: { [catJ.GroceriesJoint]: catB.Groceries },
        delete: true,
      },
      // Step 14: Mirror Joint:JointExpenses → A:Joint (delete: false!)
      {
        type: "mirror",
        source: { budget: "Joint", accounts: ["JointExpenses"] },
        destination: { budget: "A", account: "Joint" },
        delete: false,
      },
      // Step 15: Mirror Joint:JointExpenses → B:Joint
      {
        type: "mirror",
        source: { budget: "Joint", accounts: ["JointExpenses"] },
        destination: { budget: "B", account: "Joint" },
        delete: true,
      },
    ],
  };

  writeFileSync(configPath, stringify(config), "utf-8");

  return {
    rootDir: repoRoot,
    configPath,
    assertDataDir,
    binaryDataDir,
    budgets,
  };
}

// ─── Phase 1: Starting state ─────────────────────────────────────────────────

async function assertStartingState(fixture: Fixture): Promise<void> {
  await withApi(fixture.assertDataDir, async () => {
    // Source accounts have seed transactions
    assertCount(
      await getAccountTxs(fixture, "A", "Checking"),
      3,
      "A:Checking initial"
    );
    assertCount(
      await getAccountTxs(fixture, "B", "Checking"),
      2,
      "B:Checking initial"
    );
    assertCount(
      await getAccountTxs(fixture, "Joint", "Checking"),
      2,
      "Joint:Checking initial"
    );

    // All destination accounts start empty
    for (const { alias, account } of ALL_ACCOUNTS) {
      if (account === "Checking") continue; // source accounts checked above
      const txs = await getAccountTxs(fixture, alias, account);
      assertCount(txs, 0, `${alias}:${account} initial`);
    }
  });
}

// ─── Phase 2: Run 1 + assert ─────────────────────────────────────────────────

async function assertAfterRun1(
  fixture: Fixture
): Promise<Map<string, SnapshotTx[]>> {
  return withApi(fixture.assertDataDir, async () => {
    const catA = fixture.budgets.A.categoryIds;
    const catB = fixture.budgets.B.categoryIds;
    const catJ = fixture.budgets.Joint.categoryIds;

    // ── A:Checking — unchanged ──────────────────────────────────────
    const aChecking = await getAccountTxs(fixture, "A", "Checking");
    assertCount(aChecking, 3, "A:Checking after run 1");

    // ── A:Recv — 3 splits + 2 mirrors from Joint:PayA ──────────────
    const aRecv = await getAccountTxs(fixture, "A", "Recv");
    assertCount(aRecv, 5, "A:Recv after run 1");

    const aRecvRum = getOneByMarker(aRecv, MARKERS.aRum, "A:Recv rum");
    assert(aRecvRum.amount === 8000, `A:Recv rum amount: expected 8000, got ${aRecvRum.amount}`);
    assert(aRecvRum.category === catA.Rum, "A:Recv rum category should be Rum");
    assert(
      aRecvRum.imported_id?.startsWith("ABMirror:"),
      "A:Recv rum should have ABMirror imported_id"
    );

    const aRecvSub1 = getOneByMarker(aRecv, MARKERS.aGroceriesSub1, "A:Recv sub1");
    assert(aRecvSub1.amount === 3000, `A:Recv sub1 amount: expected 3000, got ${aRecvSub1.amount}`);
    assert(aRecvSub1.category === catA.Groceries, "A:Recv sub1 category should be Groceries");

    const aRecvSub2 = getOneByMarker(aRecv, MARKERS.aGroceriesSub2, "A:Recv sub2");
    assert(aRecvSub2.amount === 2000, `A:Recv sub2 amount: expected 2000, got ${aRecvSub2.amount}`);
    assert(!aRecvSub2.category, "A:Recv sub2 category should be null");

    const aRecvBGroceries = getOneByMarker(aRecv, MARKERS.bGroceries, "A:Recv from B via PayA");
    assert(
      aRecvBGroceries.amount === -5000,
      `A:Recv B groceries amount: expected -5000, got ${aRecvBGroceries.amount}`
    );
    assert(
      aRecvBGroceries.category === catA.Groceries,
      "A:Recv B groceries category should be Groceries (mapped from GroceriesJoint)"
    );

    const aRecvPersonalB = getOneByMarker(
      aRecv,
      MARKERS.jointPersonalB,
      "A:Recv personal_b offset"
    );
    assert(
      aRecvPersonalB.amount === 2000,
      `A:Recv personal_b amount: expected 2000, got ${aRecvPersonalB.amount}`
    );
    assert(!aRecvPersonalB.category, "A:Recv personal_b category should be null (Misc unmapped)");

    // ── A:Joint — 2 mirrors from JointExpenses ──────────────────────
    const aJoint = await getAccountTxs(fixture, "A", "Joint");
    assertCount(aJoint, 2, "A:Joint after run 1");

    // ── A:Savings — untouched ───────────────────────────────────────
    assertCount(await getAccountTxs(fixture, "A", "Savings"), 0, "A:Savings after run 1");

    // ── B:Checking — unchanged ──────────────────────────────────────
    const bChecking = await getAccountTxs(fixture, "B", "Checking");
    assertCount(bChecking, 2, "B:Checking after run 1");

    // ── B:Recv — 1 split + 4 mirrors from Joint:PayB ───────────────
    const bRecv = await getAccountTxs(fixture, "B", "Recv");
    assertCount(bRecv, 5, "B:Recv after run 1");

    const bRecvGroceries = getOneByMarker(bRecv, MARKERS.bGroceries, "B:Recv groceries split");
    assert(
      bRecvGroceries.amount === 5000,
      `B:Recv groceries split amount: expected 5000, got ${bRecvGroceries.amount}`
    );
    assert(
      bRecvGroceries.category === catB.Groceries,
      "B:Recv groceries split category should be Groceries"
    );

    const bRecvRum = getOneByMarker(bRecv, MARKERS.aRum, "B:Recv rum from A via PayB");
    assert(
      bRecvRum.amount === -8000,
      `B:Recv rum amount: expected -8000, got ${bRecvRum.amount}`
    );
    assert(!bRecvRum.category, "B:Recv rum category should be null (Rum unmapped)");

    const bRecvSub1 = getOneByMarker(bRecv, MARKERS.aGroceriesSub1, "B:Recv sub1 from PayB");
    assert(
      bRecvSub1.amount === -3000,
      `B:Recv sub1 amount: expected -3000, got ${bRecvSub1.amount}`
    );
    assert(
      bRecvSub1.category === catB.Groceries,
      "B:Recv sub1 category should be Groceries (mapped from GroceriesJoint)"
    );

    const bRecvSub2 = getOneByMarker(bRecv, MARKERS.aGroceriesSub2, "B:Recv sub2 from PayB");
    assert(
      bRecvSub2.amount === -2000,
      `B:Recv sub2 amount: expected -2000, got ${bRecvSub2.amount}`
    );

    const bRecvPersonalB = getOneByMarker(
      bRecv,
      MARKERS.jointPersonalB,
      "B:Recv personal_b charge"
    );
    assert(
      bRecvPersonalB.amount === -2000,
      `B:Recv personal_b amount: expected -2000, got ${bRecvPersonalB.amount}`
    );

    // ── B:Joint — 2 mirrors from JointExpenses ──────────────────────
    const bJoint = await getAccountTxs(fixture, "B", "Joint");
    assertCount(bJoint, 2, "B:Joint after run 1");

    // ── B:Savings — untouched ───────────────────────────────────────
    assertCount(await getAccountTxs(fixture, "B", "Savings"), 0, "B:Savings after run 1");

    // ── Joint:AIndv — 2 mirrors from A:Checking (#50/50 only) ──────
    const jointAIndv = await getAccountTxs(fixture, "Joint", "AIndv");
    assertCount(jointAIndv, 2, "Joint:AIndv after run 1");

    const aIndvRum = getOneByMarker(jointAIndv, MARKERS.aRum, "Joint:AIndv rum");
    assert(
      aIndvRum.amount === -16000,
      `Joint:AIndv rum amount: expected -16000, got ${aIndvRum.amount}`
    );
    assert(!aIndvRum.category, "Joint:AIndv rum category should be null (cross-budget, unmapped)");

    const aIndvSub1 = getOneByMarker(jointAIndv, MARKERS.aGroceriesSub1, "Joint:AIndv sub1");
    assert(
      aIndvSub1.amount === -6000,
      `Joint:AIndv sub1 amount: expected -6000, got ${aIndvSub1.amount}`
    );

    // ── Joint:BIndv — 1 mirror from B:Checking (#50/50) ────────────
    const jointBIndv = await getAccountTxs(fixture, "Joint", "BIndv");
    assertCount(jointBIndv, 1, "Joint:BIndv after run 1");

    const bIndvGroceries = getOneByMarker(
      jointBIndv,
      MARKERS.bGroceries,
      "Joint:BIndv groceries"
    );
    assert(
      bIndvGroceries.amount === -10000,
      `Joint:BIndv groceries amount: expected -10000, got ${bIndvGroceries.amount}`
    );

    // ── Joint:Checking — unchanged ──────────────────────────────────
    assertCount(
      await getAccountTxs(fixture, "Joint", "Checking"),
      2,
      "Joint:Checking after run 1"
    );

    // ── Joint:JointExpenses — 2 (50% default splits) ────────────────
    const jointExpenses = await getAccountTxs(fixture, "Joint", "JointExpenses");
    assertCount(jointExpenses, 2, "Joint:JointExpenses after run 1");

    const jeGames = getOneByMarker(jointExpenses, MARKERS.jointGames, "JointExpenses games");
    assert(
      jeGames.amount === -15000,
      `JointExpenses games amount: expected -15000, got ${jeGames.amount}`
    );
    assert(jeGames.category === catJ.Games, "JointExpenses games category should be Games");

    const jePersonalB = getOneByMarker(
      jointExpenses,
      MARKERS.jointPersonalB,
      "JointExpenses personal_b"
    );
    assert(
      jePersonalB.amount === -2000,
      `JointExpenses personal_b amount: expected -2000, got ${jePersonalB.amount}`
    );
    assert(jePersonalB.category === catJ.Misc, "JointExpenses personal_b category should be Misc");

    // ── Joint:PayA — 5 entries ──────────────────────────────────────
    const jointPayA = await getAccountTxs(fixture, "Joint", "PayA");
    assertCount(jointPayA, 5, "Joint:PayA after run 1");

    const payARum = getOneByMarker(jointPayA, MARKERS.aRum, "Joint:PayA rum");
    assert(
      payARum.amount === 8000,
      `Joint:PayA rum amount: expected 8000, got ${payARum.amount}`
    );
    assert(!payARum.category, "Joint:PayA rum category should be null (Rum unmapped)");

    const payASub1 = getOneByMarker(jointPayA, MARKERS.aGroceriesSub1, "Joint:PayA sub1");
    assert(
      payASub1.amount === 3000,
      `Joint:PayA sub1 amount: expected 3000, got ${payASub1.amount}`
    );
    assert(
      payASub1.category === catJ.GroceriesJoint,
      "Joint:PayA sub1 category should be GroceriesJoint"
    );

    const payABGroceries = getOneByMarker(
      jointPayA,
      MARKERS.bGroceries,
      "Joint:PayA B groceries (inverted from PayB)"
    );
    assert(
      payABGroceries.amount === -5000,
      `Joint:PayA B groceries amount: expected -5000, got ${payABGroceries.amount}`
    );

    const payAPersonalB = getOneByMarker(
      jointPayA,
      MARKERS.jointPersonalB,
      "Joint:PayA personal_b offset"
    );
    assert(
      payAPersonalB.amount === 2000,
      `Joint:PayA personal_b amount: expected 2000, got ${payAPersonalB.amount}`
    );
    assert(
      payAPersonalB.category === catJ.Misc,
      "Joint:PayA personal_b category should be Misc"
    );

    // ── Joint:PayB — 5 entries ──────────────────────────────────────
    const jointPayB = await getAccountTxs(fixture, "Joint", "PayB");
    assertCount(jointPayB, 5, "Joint:PayB after run 1");

    const payBRum = getOneByMarker(jointPayB, MARKERS.aRum, "Joint:PayB rum (inverted)");
    assert(
      payBRum.amount === -8000,
      `Joint:PayB rum amount: expected -8000, got ${payBRum.amount}`
    );

    const payBGroceries = getOneByMarker(
      jointPayB,
      MARKERS.bGroceries,
      "Joint:PayB B groceries"
    );
    assert(
      payBGroceries.amount === 5000,
      `Joint:PayB B groceries amount: expected 5000, got ${payBGroceries.amount}`
    );
    assert(
      payBGroceries.category === catJ.GroceriesJoint,
      "Joint:PayB B groceries category should be GroceriesJoint"
    );

    const payBPersonalB = getOneByMarker(
      jointPayB,
      MARKERS.jointPersonalB,
      "Joint:PayB personal_b charge"
    );
    assert(
      payBPersonalB.amount === -2000,
      `Joint:PayB personal_b amount: expected -2000, got ${payBPersonalB.amount}`
    );

    // ── Capture snapshots for idempotency check ─────────────────────
    const snapshots = new Map<string, SnapshotTx[]>();
    for (const alias of ["A", "B", "Joint"] as BudgetAlias[]) {
      await openBudget(fixture, alias);
      for (const ref of ALL_ACCOUNTS.filter((a) => a.alias === alias)) {
        const accountId = fixture.budgets[alias].accountIds[ref.account];
        assert(accountId, `Missing account "${ref.account}" for budget "${alias}"`);
        const txs = (await actual.getTransactions(
          accountId,
          TX_START,
          TX_END
        )) as TxLike[];
        snapshots.set(
          `${alias}:${ref.account}`,
          normalizeAccountSnapshot(txs)
        );
      }
    }
    return snapshots;
  });
}

// ─── Phase 3: Idempotency ────────────────────────────────────────────────────

async function assertIdempotencyAfterRun2(
  fixture: Fixture,
  run1Snapshots: Map<string, SnapshotTx[]>
): Promise<void> {
  const run2Snapshots = await captureAllSnapshots(fixture);

  for (const [key, run1Snap] of run1Snapshots) {
    const run2Snap = run2Snapshots.get(key);
    assert(run2Snap, `Missing snapshot for ${key} after run 2`);
    assertContentSnapshotsEqual(run2Snap, run1Snap, `run 2 idempotency ${key}`);
  }
}

// ─── Phase 4: Field-level sync ───────────────────────────────────────────────

async function mutateSourceAndEditDest(fixture: Fixture): Promise<void> {
  // Mutate TX-1 amount in A:Checking: -16000 → -20000
  await withApi(fixture.assertDataDir, async () => {
    const aChecking = await getAccountTxs(fixture, "A", "Checking");
    const rum = getOneByMarker(aChecking, MARKERS.aRum, "source mutation target");
    await actual.updateTransaction(rum.id, { amount: -20000 });
    await actual.sync();
  });

  // Edit user notes on B:Recv (rum mirror from A)
  await withApi(fixture.assertDataDir, async () => {
    const bRecv = await getAccountTxs(fixture, "B", "Recv");
    const bRecvRum = getOneByMarker(bRecv, MARKERS.aRum, "B:Recv preserve target");
    await actual.updateTransaction(bRecvRum.id, { notes: PRESERVED_NOTES });
    await actual.sync();
  });
}

async function assertFieldLevelSyncAfterRun3(fixture: Fixture): Promise<void> {
  await withApi(fixture.assertDataDir, async () => {
    // A:Recv split should update: -20000 * -0.5 = +10000
    const aRecv = await getAccountTxs(fixture, "A", "Recv");
    const aRecvRum = getOneByMarker(aRecv, MARKERS.aRum, "A:Recv rum after mutation");
    assert(
      aRecvRum.amount === 10000,
      `A:Recv rum should update to 10000, got ${aRecvRum.amount}`
    );

    // Joint:AIndv should update: mirror of -20000
    const jointAIndv = await getAccountTxs(fixture, "Joint", "AIndv");
    const aIndvRum = getOneByMarker(jointAIndv, MARKERS.aRum, "Joint:AIndv rum after mutation");
    assert(
      aIndvRum.amount === -20000,
      `Joint:AIndv rum should update to -20000, got ${aIndvRum.amount}`
    );

    // Joint:PayA should update: mirror of +10000
    const jointPayA = await getAccountTxs(fixture, "Joint", "PayA");
    const payARum = getOneByMarker(jointPayA, MARKERS.aRum, "Joint:PayA rum after mutation");
    assert(
      payARum.amount === 10000,
      `Joint:PayA rum should update to 10000, got ${payARum.amount}`
    );

    // Joint:PayB should update: inverted to -10000
    const jointPayB = await getAccountTxs(fixture, "Joint", "PayB");
    const payBRum = getOneByMarker(jointPayB, MARKERS.aRum, "Joint:PayB rum after mutation");
    assert(
      payBRum.amount === -10000,
      `Joint:PayB rum should update to -10000, got ${payBRum.amount}`
    );

    // B:Recv: amount updated, notes preserved
    // Notes were edited to PRESERVED_NOTES (no longer contains aRum marker).
    // Find by amount and date instead.
    const bRecv = await getAccountTxs(fixture, "B", "Recv");
    assertCount(bRecv, 5, "B:Recv count unchanged after run 3");
    const bRecvRum = visibleTxs(bRecv).find(
      (tx) => tx.amount === -10000 && tx.date === "2025-01-15"
    );
    assert(bRecvRum, "B:Recv should have a -10000 tx on 2025-01-15 (updated rum mirror)");
    assert(
      bRecvRum.notes === PRESERVED_NOTES,
      `B:Recv rum notes should be preserved as "${PRESERVED_NOTES}", got "${bRecvRum.notes}"`
    );
  });
}

// ─── Phase 5: Delete propagation ─────────────────────────────────────────────

async function deleteJointGames(fixture: Fixture): Promise<void> {
  await withApi(fixture.assertDataDir, async () => {
    const jointChecking = await getAccountTxs(fixture, "Joint", "Checking");
    const games = getOneByMarker(jointChecking, MARKERS.jointGames, "delete target TX-6");
    await actual.deleteTransaction(games.id);
    await actual.sync();
  });
}

async function assertDeletePropagation(fixture: Fixture): Promise<void> {
  await withApi(fixture.assertDataDir, async () => {
    // Joint:Checking — TX-6 deleted, only TX-7 remains
    const jointChecking = await getAccountTxs(fixture, "Joint", "Checking");
    assertCount(jointChecking, 1, "Joint:Checking after delete");

    // Joint:JointExpenses — TX-6 split deleted (step 3: delete:true), TX-7 remains
    const jointExpenses = await getAccountTxs(fixture, "Joint", "JointExpenses");
    assertCount(jointExpenses, 1, "Joint:JointExpenses after delete");

    // A:Joint — BOTH entries remain! Step 14 has delete:false, stale TX-6 preserved.
    const aJoint = await getAccountTxs(fixture, "A", "Joint");
    assertCount(aJoint, 2, "A:Joint after delete (delete:false preserves stale entry)");

    // B:Joint — TX-6 mirror deleted (step 15: delete:true), TX-7 remains
    const bJoint = await getAccountTxs(fixture, "B", "Joint");
    assertCount(bJoint, 1, "B:Joint after delete (delete:true removes stale entry)");

    // Other accounts should be unaffected (TX-6 only flows through JointExpenses)
    assertCount(await getAccountTxs(fixture, "A", "Recv"), 5, "A:Recv after delete");
    assertCount(await getAccountTxs(fixture, "B", "Recv"), 5, "B:Recv after delete");
    assertCount(await getAccountTxs(fixture, "Joint", "PayA"), 5, "Joint:PayA after delete");
    assertCount(await getAccountTxs(fixture, "Joint", "PayB"), 5, "Joint:PayB after delete");
    assertCount(await getAccountTxs(fixture, "Joint", "AIndv"), 2, "Joint:AIndv after delete");
    assertCount(await getAccountTxs(fixture, "Joint", "BIndv"), 1, "Joint:BIndv after delete");
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const fixture = await bootstrap();

  console.log("Phase 1: Asserting starting state...");
  await assertStartingState(fixture);

  console.log("Phase 2: Running pipeline (run 1)...");
  runPipeline(fixture);
  const run1Snapshots = await assertAfterRun1(fixture);

  console.log("Phase 3: Running pipeline (run 2, idempotency)...");
  runPipeline(fixture);
  await assertIdempotencyAfterRun2(fixture, run1Snapshots);

  console.log("Phase 4: Field-level sync (mutate source + preserve notes)...");
  await mutateSourceAndEditDest(fixture);
  runPipeline(fixture);
  await assertFieldLevelSyncAfterRun3(fixture);

  console.log("Phase 5: Delete propagation (delete:true vs delete:false)...");
  await deleteJointGames(fixture);
  runPipeline(fixture);
  await assertDeletePropagation(fixture);

  console.log("Joint-finances e2e test passed.");
}

main().catch((err: unknown) => {
  console.error("Joint-finances e2e test failed:", err);
  process.exit(1);
});
