import * as actual from "@actual-app/api";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";

type BudgetAlias = "alpha" | "beta" | "gamma" | "delta";
type AccountName = "Checking" | "Recv" | "DeleteDest" | "Dup1" | "Dup2";

type BudgetFixture = {
  name: BudgetAlias;
  syncId: string;
  encrypted: boolean;
  accountIds: Partial<Record<AccountName, string>>;
};

type Fixture = {
  rootDir: string;
  configPath: string;
  assertDataDir: string;
  binaryDataDir: string;
  gammaPassword: string;
  serverPassword: string;
  budgets: Record<BudgetAlias, BudgetFixture>;
};

type TxLike = {
  id: string;
  date: string;
  amount: number;
  payee_name?: string | null;
  notes?: string | null;
  category?: string | null;
  cleared?: boolean | null;
  imported_id?: string | null;
  tombstone?: boolean;
  is_child?: boolean;
  is_parent?: boolean;
  subtransactions?: Array<{
    id: string;
    amount: number;
    notes?: string | null;
    date: string;
    imported_id?: string | null;
  }>;
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

const SERVER_URL = "http://localhost:5007";
const SERVER_PASSWORD = "test";
const GAMMA_KEY = "gamma-test-key";
const TX_START = "2000-01-01";
const TX_END = "2100-01-01";
const EXTERNAL_IMPORTED_ID = "ext-bank-seed-001";
const PRESERVED_NOTES = "IT_preserved_user_notes";

const MARKERS = {
  alphaGroceriesParent: "IT_alpha_groceries_parent",
  alphaGroceriesSub1: "IT_alpha_groceries_sub1",
  alphaGroceriesSub2: "IT_alpha_groceries_sub2",
  alphaTaggedFlat: "IT_alpha_tagged_flat",
  alphaMissingSync: "IT_alpha_missing_sync",
  alphaMultiAction: "IT_alpha_multi_action",
  alphaCoffee: "IT_alpha_coffee",
  alphaRent: "IT_alpha_rent",
  alphaExternalImported: "IT_alpha_external_imported",
  betaDinner: "IT_beta_dinner",
  betaDeleteDestManual: "IT_beta_delete_dest_manual",
} as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function rootDir(): string {
  return path.resolve(__dirname, "..", "..");
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function isoDate(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function visibleTxs(txs: TxLike[]): TxLike[] {
  return txs.filter((t) => !t.tombstone && !t.is_child);
}

function txHasMarker(tx: TxLike, marker: string): boolean {
  return Boolean(tx.notes?.includes(marker) || tx.payee_name?.includes(marker));
}

function getOneByMarker(txs: TxLike[], marker: string, context: string): TxLike {
  const matches = visibleTxs(txs).filter((tx) => txHasMarker(tx, marker));
  assert(matches.length === 1, `${context}: expected exactly one marker ${marker}, got ${matches.length}`);
  return matches[0];
}

function getByImportedId(txs: TxLike[], importedId: string, context: string): TxLike {
  const matches = visibleTxs(txs).filter((tx) => tx.imported_id === importedId);
  assert(
    matches.length === 1,
    `${context}: expected exactly one tx imported_id=${importedId}, got ${matches.length}`
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

function assertSnapshotsEqual(actualSnapshot: SnapshotTx[], expected: SnapshotTx[], context: string): void {
  const actualJson = JSON.stringify(actualSnapshot);
  const expectedJson = JSON.stringify(expected);
  assert(
    actualJson === expectedJson,
    `${context}: snapshot mismatch\nexpected=${expectedJson}\nactual=${actualJson}`
  );
}

function expectedImportedId(sourceBudgetId: string, sourceTxId: string): string {
  return `ABMirror:${sourceBudgetId}:${sourceTxId}`;
}

async function withApi<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const initConfig: { dataDir: string; serverURL: string; password?: string } = {
    dataDir,
    serverURL: SERVER_URL,
  };
  initConfig.password = SERVER_PASSWORD;
  await actual.init(initConfig);
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

async function getLocalBudgetIdBySyncId(syncId: string): Promise<string> {
  const budgets = await actual.getBudgets();
  const found = budgets.find((b) => b.groupId === syncId && Boolean(b.id));
  assert(found?.id, `Could not resolve local budget id for syncId "${syncId}"`);
  return found.id;
}

async function openBudget(fixture: Fixture, alias: BudgetAlias): Promise<BudgetFixture> {
  const budget = fixture.budgets[alias];
  assert(budget, `Unknown budget alias "${alias}"`);
  const password = budget.encrypted ? fixture.gammaPassword : undefined;
  await actual.downloadBudget(budget.syncId, { password });
  return budget;
}

async function getAccountTransactions(
  fixture: Fixture,
  alias: BudgetAlias,
  accountName: AccountName
): Promise<TxLike[]> {
  const budget = await openBudget(fixture, alias);
  const accountId = budget.accountIds[accountName];
  assert(accountId, `Missing account "${accountName}" for budget "${alias}"`);
  const txs = await actual.getTransactions(accountId, TX_START, TX_END);
  return txs as TxLike[];
}

function runMirrorBinary(fixture: Fixture): void {
  execSync(`node dist/cli.js run --config "${fixture.configPath}"`, {
    cwd: fixture.rootDir,
    stdio: "inherit",
    env: {
      ...process.env,
      AB_MIRROR_KEY_GAMMA: fixture.gammaPassword,
      AB_MIRROR_SERVER_PASSWORD: fixture.serverPassword,
    },
  });
}

function runValidate(configPath: string, fixture: Fixture): { exitCode: number; stderr: string } {
  const result = spawnSync("node", ["dist/cli.js", "validate", "--config", configPath], {
    cwd: fixture.rootDir,
    encoding: "utf-8",
    env: {
      ...process.env,
      AB_MIRROR_KEY_GAMMA: fixture.gammaPassword,
      AB_MIRROR_SERVER_PASSWORD: fixture.serverPassword,
    },
  });
  return {
    exitCode: result.status ?? (result.signal ? 1 : 0),
    stderr: result.stderr ?? "",
  };
}

async function bootstrap(): Promise<Fixture> {
  const repoRoot = rootDir();
  const assertDataDir = makeTempDir("abm-it-assert-");
  const binaryDataDir = makeTempDir("abm-it-binary-");
  const bootstrapDataDir = makeTempDir("abm-it-bootstrap-");
  const configPath = path.join(repoRoot, "test/integration/.tmp-config.yaml");
  mkdirSync(path.dirname(configPath), { recursive: true });

  const budgets: Record<BudgetAlias, BudgetFixture> = {
    alpha: { name: "alpha", syncId: "", encrypted: false, accountIds: {} },
    beta: { name: "beta", syncId: "", encrypted: false, accountIds: {} },
    gamma: { name: "gamma", syncId: "", encrypted: true, accountIds: {} },
    delta: { name: "delta", syncId: "", encrypted: false, accountIds: {} },
  };

  await withApi(bootstrapDataDir, async () => {
    const date = isoDate(0);

    await actual.runImport("alpha", async () => {
      const checking = await actual.createAccount({ name: "Checking", offbudget: false }, 0);
      const recv = await actual.createAccount({ name: "Recv", offbudget: false }, 0);
      budgets.alpha.accountIds.Checking = checking;
      budgets.alpha.accountIds.Recv = recv;

      await actual.addTransactions(checking, [
        {
          date,
          amount: -3333,
          payee_name: "Groceries",
          notes: MARKERS.alphaGroceriesParent,
          subtransactions: [
            { amount: -1111, notes: MARKERS.alphaGroceriesSub1 },
            { amount: -2222, notes: MARKERS.alphaGroceriesSub2 },
          ],
        },
        {
          date,
          amount: -1200,
          payee_name: "Tagged flat",
          notes: `#test #Sync #50/50 ${MARKERS.alphaTaggedFlat}`,
        },
        {
          date,
          amount: -1300,
          payee_name: "Missing sync required tag",
          notes: `#test #50/50 ${MARKERS.alphaMissingSync}`,
        },
        {
          date,
          amount: -7000,
          payee_name: "Multi action tags",
          notes: `#TeSt #sync #0/100 #50/50 ${MARKERS.alphaMultiAction}`,
        },
        {
          date,
          amount: -3303,
          payee_name: "Coffee",
          notes: MARKERS.alphaCoffee,
        },
        {
          date,
          amount: -10100,
          payee_name: "Rent",
          notes: `#Test #SYNC #0/100 ${MARKERS.alphaRent}`,
        },
        {
          date,
          amount: -1500,
          payee_name: "Externally imported",
          notes: `#test #sync #50/50 ${MARKERS.alphaExternalImported}`,
          imported_id: EXTERNAL_IMPORTED_ID,
        },
      ]);
    });
    budgets.alpha.syncId = await getSyncIdByBudgetName("alpha");

    await actual.runImport("beta", async () => {
      const checking = await actual.createAccount({ name: "Checking", offbudget: false }, 0);
      const recv = await actual.createAccount({ name: "Recv", offbudget: false }, 0);
      const deleteDest = await actual.createAccount({ name: "DeleteDest", offbudget: false }, 0);
      budgets.beta.accountIds.Checking = checking;
      budgets.beta.accountIds.Recv = recv;
      budgets.beta.accountIds.DeleteDest = deleteDest;

      await actual.addTransactions(checking, [
        {
          date,
          amount: -4100,
          payee_name: "Dinner",
          notes: MARKERS.betaDinner,
        },
      ]);

      await actual.addTransactions(deleteDest, [
        {
          date,
          amount: -501,
          payee_name: "Manual Keep",
          notes: MARKERS.betaDeleteDestManual,
        },
      ]);
    });
    budgets.beta.syncId = await getSyncIdByBudgetName("beta");

    await actual.runImport("gamma", async () => {
      const recv = await actual.createAccount({ name: "Recv", offbudget: false }, 0);
      budgets.gamma.accountIds.Recv = recv;
    });
    budgets.gamma.syncId = await getSyncIdByBudgetName("gamma");

    await actual.downloadBudget(budgets.gamma.syncId);
    await actual.internal.send("key-make", { password: GAMMA_KEY });
    await actual.sync();
    budgets.gamma.syncId = await getSyncIdByBudgetName("gamma");

    await actual.runImport("delta", async () => {
      const dup1 = await actual.createAccount({ name: "Dup", offbudget: false }, 0);
      const dup2 = await actual.createAccount({ name: "Dup", offbudget: true }, 0);
      budgets.delta.accountIds.Dup1 = dup1;
      budgets.delta.accountIds.Dup2 = dup2;
    });
    budgets.delta.syncId = await getSyncIdByBudgetName("delta");
  });

  const fixture: Fixture = {
    rootDir: repoRoot,
    configPath,
    assertDataDir,
    binaryDataDir,
    gammaPassword: GAMMA_KEY,
    serverPassword: SERVER_PASSWORD,
    budgets,
  };

  const config = {
    server: { url: SERVER_URL },
    dataDir: fixture.binaryDataDir,
    budgets: {
      alpha: { syncId: budgets.alpha.syncId, encrypted: false },
      beta: { syncId: budgets.beta.syncId, encrypted: false },
      gamma: { syncId: budgets.gamma.syncId, encrypted: true },
    },
    lookbackDays: 3650,
    pipeline: [
      {
        type: "split",
        budget: "alpha",
        source: {
          accounts: [budgets.alpha.accountIds.Checking],
          requiredTags: ["#test", "#sync"],
        },
        tags: {
          "#50/50": {
            multiplier: -0.5,
            destination_account: budgets.alpha.accountIds.Recv,
          },
          "#0/100": {
            multiplier: -1.0,
            destination_account: budgets.alpha.accountIds.Recv,
          },
        },
      },
      {
        type: "mirror",
        source: { budget: "alpha", accounts: [budgets.alpha.accountIds.Recv] },
        destination: { budget: "beta", account: budgets.beta.accountIds.Recv },
        copyMirrored: true,
      },
      {
        type: "mirror",
        source: { budget: "beta", accounts: [budgets.beta.accountIds.Checking] },
        destination: { budget: "alpha", account: budgets.alpha.accountIds.Recv },
        invert: true,
      },
      {
        type: "mirror",
        source: { budget: "alpha", accounts: [budgets.alpha.accountIds.Recv] },
        destination: { budget: "beta", account: budgets.beta.accountIds.Recv },
        copyMirrored: true,
      },
      {
        type: "mirror",
        source: { budget: "alpha", accounts: [budgets.alpha.accountIds.Recv] },
        destination: { budget: "gamma", account: budgets.gamma.accountIds.Recv },
        copyMirrored: true,
      },
      {
        type: "mirror",
        source: { budget: "alpha", accounts: [budgets.alpha.accountIds.Checking] },
        destination: {
          budget: "beta",
          account: budgets.beta.accountIds.DeleteDest,
        },
        delete: true,
      },
    ],
  };

  writeFileSync(configPath, stringify(config), "utf-8");
  return fixture;
}

async function assertStartingState(fixture: Fixture): Promise<void> {
  await withApi(fixture.assertDataDir, async () => {
    const alphaRecv = await getAccountTransactions(fixture, "alpha", "Recv");
    const betaRecv = await getAccountTransactions(fixture, "beta", "Recv");
    const betaDeleteDest = await getAccountTransactions(fixture, "beta", "DeleteDest");
    const gammaRecv = await getAccountTransactions(fixture, "gamma", "Recv");

    assert(visibleTxs(alphaRecv).length === 0, "alpha/Recv should start empty");
    assert(visibleTxs(betaRecv).length === 0, "beta/Recv should start empty");
    assert(visibleTxs(gammaRecv).length === 0, "gamma/Recv should start empty");
    assert(visibleTxs(betaDeleteDest).length === 1, "beta/DeleteDest should start with one manual tx");
    getOneByMarker(betaDeleteDest, MARKERS.betaDeleteDestManual, "initial manual tx");
  });
}

async function snapshotAlphaChecking(fixture: Fixture): Promise<SnapshotTx[]> {
  return withApi(fixture.assertDataDir, async () => {
    const txs = await getAccountTransactions(fixture, "alpha", "Checking");
    return normalizeAccountSnapshot(txs);
  });
}

type Run1Snapshot = {
  alphaRecv: SnapshotTx[];
  betaRecv: SnapshotTx[];
  gammaRecv: SnapshotTx[];
  betaDeleteDest: SnapshotTx[];
};

async function assertAfterRun1(fixture: Fixture): Promise<Run1Snapshot> {
  return withApi(fixture.assertDataDir, async () => {
    const alphaBudgetId = await getLocalBudgetIdBySyncId(fixture.budgets.alpha.syncId);
    const betaRecv = await getAccountTransactions(fixture, "beta", "Recv");
    const alphaRecv = await getAccountTransactions(fixture, "alpha", "Recv");
    const gammaRecv = await getAccountTransactions(fixture, "gamma", "Recv");
    const betaDeleteDest = await getAccountTransactions(fixture, "beta", "DeleteDest");

    const alphaTaggedFlat = getOneByMarker(alphaRecv, MARKERS.alphaTaggedFlat, "alpha/Recv tagged flat");
    const alphaMultiAction = getOneByMarker(alphaRecv, MARKERS.alphaMultiAction, "alpha/Recv multi-action");
    const alphaRent = getOneByMarker(alphaRecv, MARKERS.alphaRent, "alpha/Recv rent");
    const alphaDinner = getOneByMarker(alphaRecv, MARKERS.betaDinner, "alpha/Recv inverted beta dinner");
    const alphaExternal = getOneByMarker(
      alphaRecv,
      MARKERS.alphaExternalImported,
      "alpha/Recv external imported source"
    );

    assert(alphaTaggedFlat.amount === 600, "alpha/Recv tagged flat should split to +600");
    assert(alphaMultiAction.amount === 3500, "alpha/Recv multi-action should use first matching tag (#50/50)");
    assert(alphaRent.amount === 10100, "alpha/Recv rent should split to +10100");
    assert(alphaDinner.amount === 4100, "alpha/Recv inverted beta dinner should be +4100");
    assert(alphaExternal.amount === 750, "alpha/Recv external imported should split to +750");
    assert(
      alphaTaggedFlat.imported_id?.endsWith(`:${getOneByMarker(await getAccountTransactions(fixture, "alpha", "Checking"), MARKERS.alphaTaggedFlat, "alpha/Checking tagged flat").id}`),
      "alpha/Recv tagged flat imported_id should map to source tx id"
    );

    const betaTaggedFlat = getByImportedId(
      betaRecv,
      expectedImportedId(alphaBudgetId, alphaTaggedFlat.id),
      "beta/Recv tagged flat mirror"
    );
    const gammaTaggedFlat = getByImportedId(
      gammaRecv,
      expectedImportedId(alphaBudgetId, alphaTaggedFlat.id),
      "gamma/Recv tagged flat mirror"
    );
    assert(betaTaggedFlat.amount === 600, "beta/Recv tagged flat amount should mirror alpha/Recv");
    assert(gammaTaggedFlat.amount === 600, "gamma/Recv tagged flat amount should mirror alpha/Recv");
    assert(betaTaggedFlat.date === alphaTaggedFlat.date, "beta/Recv tagged flat date should match source");
    assert(gammaTaggedFlat.date === alphaTaggedFlat.date, "gamma/Recv tagged flat date should match source");

    assert(
      visibleTxs(alphaRecv).length === 5,
      "alpha/Recv should have 5 tx after run 1 (4 split + 1 invert mirror)"
    );
    assert(visibleTxs(betaRecv).length === 5, "beta/Recv should have 5 mirrored tx after run 1");
    assert(visibleTxs(gammaRecv).length === 5, "gamma/Recv should have 5 mirrored tx after run 1");
    assert(
      visibleTxs(betaDeleteDest).length === 9,
      "beta/DeleteDest should have 8 mirrored + 1 manual tx after run 1"
    );

    getOneByMarker(betaDeleteDest, MARKERS.alphaGroceriesSub1, "beta/DeleteDest subtx1");
    getOneByMarker(betaDeleteDest, MARKERS.alphaGroceriesSub2, "beta/DeleteDest subtx2");
    getOneByMarker(betaDeleteDest, MARKERS.alphaTaggedFlat, "beta/DeleteDest tagged flat");
    getOneByMarker(betaDeleteDest, MARKERS.alphaMissingSync, "beta/DeleteDest missing-sync");
    getOneByMarker(betaDeleteDest, MARKERS.alphaMultiAction, "beta/DeleteDest multi-action");
    getOneByMarker(betaDeleteDest, MARKERS.alphaCoffee, "beta/DeleteDest coffee");
    getOneByMarker(betaDeleteDest, MARKERS.alphaRent, "beta/DeleteDest rent");
    const deleteDestExternal = getOneByMarker(
      betaDeleteDest,
      MARKERS.alphaExternalImported,
      "beta/DeleteDest external imported"
    );
    assert(
      deleteDestExternal.imported_id?.startsWith("ABMirror:"),
      "mirror output should always use ABMirror imported_id even when source imported_id is non-null"
    );
    getOneByMarker(betaDeleteDest, MARKERS.betaDeleteDestManual, "beta/DeleteDest manual untouched");

    return {
      alphaRecv: normalizeAccountSnapshot(alphaRecv),
      betaRecv: normalizeAccountSnapshot(betaRecv),
      gammaRecv: normalizeAccountSnapshot(gammaRecv),
      betaDeleteDest: normalizeAccountSnapshot(betaDeleteDest),
    };
  });
}

async function assertIdempotencyAfterRun2(fixture: Fixture, run1: Run1Snapshot): Promise<void> {
  await withApi(fixture.assertDataDir, async () => {
    const alphaRecv = await getAccountTransactions(fixture, "alpha", "Recv");
    const betaRecv = await getAccountTransactions(fixture, "beta", "Recv");
    const gammaRecv = await getAccountTransactions(fixture, "gamma", "Recv");
    const betaDeleteDest = await getAccountTransactions(fixture, "beta", "DeleteDest");

    assertSnapshotsEqual(
      normalizeAccountSnapshot(alphaRecv),
      run1.alphaRecv,
      "run2 idempotency alpha/Recv"
    );
    assertSnapshotsEqual(normalizeAccountSnapshot(betaRecv), run1.betaRecv, "run2 idempotency beta/Recv");
    assertSnapshotsEqual(
      normalizeAccountSnapshot(gammaRecv),
      run1.gammaRecv,
      "run2 idempotency gamma/Recv"
    );
    assertSnapshotsEqual(
      normalizeAccountSnapshot(betaDeleteDest),
      run1.betaDeleteDest,
      "run2 idempotency beta/DeleteDest"
    );
  });
}

async function mutateSourceForFieldSync(fixture: Fixture): Promise<{ updatedDate: string }> {
  return withApi(fixture.assertDataDir, async () => {
    const alphaChecking = await getAccountTransactions(fixture, "alpha", "Checking");
    const taggedFlat = getOneByMarker(alphaChecking, MARKERS.alphaTaggedFlat, "source update target");
    const updatedDate = isoDate(-1);
    await actual.updateTransaction(taggedFlat.id, { amount: -1400, date: updatedDate });
    await actual.sync();
    return { updatedDate };
  });
}

async function editBetaDestinationUserFields(fixture: Fixture): Promise<void> {
  await withApi(fixture.assertDataDir, async () => {
    const alphaBudgetId = await getLocalBudgetIdBySyncId(fixture.budgets.alpha.syncId);
    const alphaRecv = await getAccountTransactions(fixture, "alpha", "Recv");
    const betaRecv = await getAccountTransactions(fixture, "beta", "Recv");
    const alphaTaggedFlat = getOneByMarker(alphaRecv, MARKERS.alphaTaggedFlat, "alpha/Recv for preserve test");
    const betaTaggedFlat = getByImportedId(
      betaRecv,
      expectedImportedId(alphaBudgetId, alphaTaggedFlat.id),
      "beta/Recv preserve target"
    );
    await actual.updateTransaction(betaTaggedFlat.id, {
      notes: PRESERVED_NOTES,
    });
    await actual.sync();
  });
}

async function assertFieldLevelSyncAfterRun3(fixture: Fixture, updatedDate: string): Promise<void> {
  await withApi(fixture.assertDataDir, async () => {
    const alphaBudgetId = await getLocalBudgetIdBySyncId(fixture.budgets.alpha.syncId);
    const alphaRecv = await getAccountTransactions(fixture, "alpha", "Recv");
    const betaRecv = await getAccountTransactions(fixture, "beta", "Recv");
    const gammaRecv = await getAccountTransactions(fixture, "gamma", "Recv");
    const alphaTaggedFlat = getOneByMarker(alphaRecv, MARKERS.alphaTaggedFlat, "alpha/Recv after source update");

    assert(alphaTaggedFlat.amount === 700, "alpha/Recv tagged flat should update split amount to +700");
    assert(alphaTaggedFlat.date === updatedDate, "alpha/Recv tagged flat should update date");

    const betaTaggedFlat = getByImportedId(
      betaRecv,
      expectedImportedId(alphaBudgetId, alphaTaggedFlat.id),
      "beta/Recv after source update"
    );
    const gammaTaggedFlat = getByImportedId(
      gammaRecv,
      expectedImportedId(alphaBudgetId, alphaTaggedFlat.id),
      "gamma/Recv after source update"
    );

    assert(betaTaggedFlat.amount === 700, "beta/Recv should update amount from source");
    assert(betaTaggedFlat.date === updatedDate, "beta/Recv should update date from source");
    assert(betaTaggedFlat.notes === PRESERVED_NOTES, "beta/Recv should preserve user-edited notes");

    assert(gammaTaggedFlat.amount === 700, "gamma/Recv should update amount from source");
    assert(gammaTaggedFlat.date === updatedDate, "gamma/Recv should update date from source");
  });
}

async function deleteCoffeeFromAlpha(fixture: Fixture): Promise<void> {
  await withApi(fixture.assertDataDir, async () => {
    const alphaChecking = await getAccountTransactions(fixture, "alpha", "Checking");
    const coffee = getOneByMarker(alphaChecking, MARKERS.alphaCoffee, "delete coffee source");
    await actual.deleteTransaction(coffee.id);
    await actual.sync();
  });
}

async function assertAfterDeleteRun4(fixture: Fixture): Promise<void> {
  await withApi(fixture.assertDataDir, async () => {
    const betaDeleteDest = await getAccountTransactions(fixture, "beta", "DeleteDest");
    const visible = visibleTxs(betaDeleteDest);
    assert(
      visible.length === 8,
      "beta/DeleteDest should have 7 mirrored + 1 manual tx after deleting coffee source"
    );

    const manual = getOneByMarker(betaDeleteDest, MARKERS.betaDeleteDestManual, "manual tx must remain");
    assert(!manual.imported_id?.startsWith("ABMirror:"), "manual tx must remain user-owned");

    const coffeeMatches = visible.filter((tx) => txHasMarker(tx, MARKERS.alphaCoffee));
    assert(coffeeMatches.length === 0, "coffee mirror should be deleted from beta/DeleteDest");

    getOneByMarker(betaDeleteDest, MARKERS.alphaGroceriesSub1, "post-delete keep sub1");
    getOneByMarker(betaDeleteDest, MARKERS.alphaGroceriesSub2, "post-delete keep sub2");
    getOneByMarker(betaDeleteDest, MARKERS.alphaTaggedFlat, "post-delete keep tagged flat");
    getOneByMarker(betaDeleteDest, MARKERS.alphaMissingSync, "post-delete keep missing-sync");
    getOneByMarker(betaDeleteDest, MARKERS.alphaMultiAction, "post-delete keep multi-action");
    getOneByMarker(betaDeleteDest, MARKERS.alphaRent, "post-delete keep rent");
    getOneByMarker(betaDeleteDest, MARKERS.alphaExternalImported, "post-delete keep external imported");
  });
}

async function main(): Promise<void> {
  const fixture = await bootstrap();

  console.log("Asserting starting state...");
  await assertStartingState(fixture);
  const sourceBeforeRun1 = await snapshotAlphaChecking(fixture);

  console.log("Running pipeline (run 1)...");
  runMirrorBinary(fixture);
  const run1Snapshot = await assertAfterRun1(fixture);
  assertSnapshotsEqual(
    await snapshotAlphaChecking(fixture),
    sourceBeforeRun1,
    "source integrity after run 1"
  );

  console.log("Running pipeline (run 2, deep idempotency)...");
  runMirrorBinary(fixture);
  await assertIdempotencyAfterRun2(fixture, run1Snapshot);
  assertSnapshotsEqual(
    await snapshotAlphaChecking(fixture),
    sourceBeforeRun1,
    "source integrity after run 2"
  );

  console.log("Preparing field-level sync test (mutate source + preserve destination fields)...");
  const sourceEdit = await mutateSourceForFieldSync(fixture);
  await editBetaDestinationUserFields(fixture);
  const sourceAfterManualEdit = await snapshotAlphaChecking(fixture);

  console.log("Running pipeline (run 3, field-level sync)...");
  runMirrorBinary(fixture);
  await assertFieldLevelSyncAfterRun3(fixture, sourceEdit.updatedDate);
  assertSnapshotsEqual(
    await snapshotAlphaChecking(fixture),
    sourceAfterManualEdit,
    "source integrity after run 3"
  );

  console.log("Deleting coffee in source and running pipeline (run 4, delete safety)...");
  await deleteCoffeeFromAlpha(fixture);
  const sourceAfterCoffeeDelete = await snapshotAlphaChecking(fixture);
  runMirrorBinary(fixture);
  await assertAfterDeleteRun4(fixture);
  assertSnapshotsEqual(
    await snapshotAlphaChecking(fixture),
    sourceAfterCoffeeDelete,
    "source integrity after run 4"
  );

  console.log("Testing duplicate account name failure (actionable dump)...");
  const dupConfigPath = path.join(path.dirname(fixture.configPath), ".tmp-dup-config.yaml");
  const dupConfig = {
    server: { url: SERVER_URL },
    dataDir: fixture.binaryDataDir,
    budgets: {
      delta: { syncId: fixture.budgets.delta.syncId, encrypted: false },
    },
    lookbackDays: 3650,
    pipeline: [
      {
        type: "split",
        budget: "delta",
        source: { accounts: "all", requiredTags: [] },
        tags: {
          "#x": {
            multiplier: 1,
            destination_account: fixture.budgets.delta.accountIds.Dup1,
          },
        },
      },
    ],
  };
  writeFileSync(dupConfigPath, stringify(dupConfig), "utf-8");
  const dupResult = runValidate(dupConfigPath, fixture);
  assert(dupResult.exitCode !== 0, "validate should fail when budget has duplicate account names");
  assert(
    dupResult.stderr.includes('Duplicate account name "Dup"'),
    "stderr should include duplicate name message"
  );
  assert(
    dupResult.stderr.includes("id:") && dupResult.stderr.includes("on-budget") && dupResult.stderr.includes("off-budget"),
    "stderr should include actionable dump with ids and basic info"
  );

  console.log("Testing account name resolution in config...");
  const nameConfigPath = path.join(path.dirname(fixture.configPath), ".tmp-name-config.yaml");
  const nameConfig = {
    server: { url: SERVER_URL },
    dataDir: fixture.binaryDataDir,
    budgets: {
      alpha: { syncId: fixture.budgets.alpha.syncId, encrypted: false },
      beta: { syncId: fixture.budgets.beta.syncId, encrypted: false },
    },
    lookbackDays: 3650,
    pipeline: [
      {
        type: "split",
        budget: "alpha",
        source: {
          accounts: ["Checking"],
          requiredTags: ["#test", "#sync"],
        },
        tags: {
          "#50/50": {
            multiplier: -0.5,
            destination_account: "Recv",
          },
        },
      },
    ],
  };
  writeFileSync(nameConfigPath, stringify(nameConfig), "utf-8");
  const nameValidateResult = runValidate(nameConfigPath, fixture);
  assert(nameValidateResult.exitCode === 0, "validate should pass with account names in config");
  execSync(`node dist/cli.js run --config "${nameConfigPath}"`, {
    cwd: fixture.rootDir,
    stdio: "pipe",
    env: {
      ...process.env,
      AB_MIRROR_KEY_GAMMA: fixture.gammaPassword,
      AB_MIRROR_SERVER_PASSWORD: fixture.serverPassword,
    },
  });

  console.log("Testing split source/dest overlap validation...");
  const overlapConfigPath = path.join(path.dirname(fixture.configPath), ".tmp-overlap-config.yaml");
  const overlapConfig = {
    server: { url: SERVER_URL },
    dataDir: fixture.binaryDataDir,
    budgets: {
      alpha: { syncId: fixture.budgets.alpha.syncId, encrypted: false },
    },
    lookbackDays: 3650,
    pipeline: [
      {
        type: "split",
        budget: "alpha",
        source: { accounts: "all" },
        tags: {
          "#50/50": {
            multiplier: -0.5,
            destination_account: "Checking",
          },
        },
      },
    ],
  };
  writeFileSync(overlapConfigPath, stringify(overlapConfig), "utf-8");
  const overlapResult = runValidate(overlapConfigPath, fixture);
  assert(overlapResult.exitCode !== 0, "validate should fail when split destination is in source scope");
  assert(
    overlapResult.stderr.includes("split destination account is in source scope"),
    "stderr should include overlap error message"
  );

  console.log("Blackbox integration test passed.");
}

main().catch((err: unknown) => {
  console.error("Blackbox integration test failed:", err);
  process.exit(1);
});
