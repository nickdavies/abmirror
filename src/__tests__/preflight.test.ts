import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPreflight } from "../orchestrator/preflight";
import type { BudgetManager } from "../client/budget-manager";
import type { Config, SplitStep } from "../config/schema";
import type { ActualAccount } from "../selector/types";

const CHECKING_ID = "checking-uuid-1111-2222-3333-444444444444";
const RECV_ID = "recv-uuid-1111-2222-3333-444444444444";

const mockAccounts: ActualAccount[] = [
  { id: CHECKING_ID, name: "Checking", offbudget: false, closed: false },
  { id: RECV_ID, name: "Recv", offbudget: false, closed: false },
];

vi.mock("@actual-app/api", () => ({
  getAccounts: vi.fn().mockResolvedValue([
    {
      id: "checking-uuid-1111-2222-3333-444444444444",
      name: "Checking",
      offbudget: false,
      closed: false,
    },
    {
      id: "recv-uuid-1111-2222-3333-444444444444",
      name: "Recv",
      offbudget: false,
      closed: false,
    },
  ]),
  getBudgets: vi.fn().mockResolvedValue([{ id: "budget-1", groupId: "sync-alpha" }]),
  getCategories: vi.fn().mockResolvedValue([]),
  init: vi.fn().mockResolvedValue(undefined),
  downloadBudget: vi.fn().mockResolvedValue(undefined),
  sync: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
}));

function createMockManager(): BudgetManager {
  const info = { alias: "alpha", budgetId: "budget-1", syncId: "sync-alpha" };
  return {
    init: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue(info),
    open: vi.fn().mockResolvedValue(info),
    getInfo: vi.fn().mockReturnValue(info),
    getOpenAlias: vi.fn().mockReturnValue("alpha"),
    syncAll: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as BudgetManager;
}

function createOverlapConfig(): Config {
  return {
    server: { url: "http://localhost:5006" },
    dataDir: "/tmp/ab-mirror-test",
    budgets: {
      alpha: { syncId: "sync-alpha", encrypted: false },
    },
    lookbackDays: 60,
    pipeline: [
      {
        type: "split",
        budget: "alpha",
        source: { accounts: "all", splitMirrored: false },
        tags: {
          "#50/50": {
            multiplier: -0.5,
            destination_account: "Checking",
          },
        },
      } satisfies SplitStep,
    ],
  };
}

function createNonOverlapConfig(): Config {
  return {
    server: { url: "http://localhost:5006" },
    dataDir: "/tmp/ab-mirror-test",
    budgets: {
      alpha: { syncId: "sync-alpha", encrypted: false },
    },
    lookbackDays: 60,
    pipeline: [
      {
        type: "split",
        budget: "alpha",
        source: { accounts: ["Checking"], splitMirrored: false },
        tags: {
          "#50/50": {
            multiplier: -0.5,
            destination_account: "Recv",
          },
        },
      } satisfies SplitStep,
    ],
  };
}

describe("runPreflight", () => {
  beforeEach(async () => {
    const actual = await import("@actual-app/api");
    vi.mocked(actual.getAccounts).mockResolvedValue(mockAccounts);
  });

  it("fails when split destination account is in source scope", async () => {
    const config = createOverlapConfig();
    const manager = createMockManager();

    const result = await runPreflight(config, manager);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "step[0] (split): split destination account is in source scope -- use explicit source accounts or exclude it"
    );
  });

  it("passes when split source and destination do not overlap", async () => {
    const config = createNonOverlapConfig();
    const manager = createMockManager();

    const result = await runPreflight(config, manager);

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("emits closedAccountInScope warning when account is closed", async () => {
    const closedAccount = {
      id: CHECKING_ID,
      name: "Checking",
      offbudget: false,
      closed: true,
    };
    const actual = await import("@actual-app/api");
    vi.mocked(actual.getAccounts).mockResolvedValue([
      closedAccount,
      { id: RECV_ID, name: "Recv", offbudget: false, closed: false },
    ]);

    const config = createNonOverlapConfig();
    const manager = createMockManager();
    const reporter = {
      warn: vi.fn(),
      recordStep: vi.fn(),
      getSummary: vi.fn(),
      send: vi.fn(),
    };

    const result = await runPreflight(config, manager, reporter);

    expect(result.ok).toBe(true);
    expect(reporter.warn).toHaveBeenCalledWith("preflight.closedAccountInScope", {
      stepIndex: 0,
      budget: "alpha",
      accountName: "Checking",
      accountId: CHECKING_ID,
    });
  });

  it("emits emptySourceScope warning when all accounts are closed (all filter)", async () => {
    const actual = await import("@actual-app/api");
    vi.mocked(actual.getAccounts).mockResolvedValue([
      { id: CHECKING_ID, name: "Checking", offbudget: false, closed: true },
      { id: RECV_ID, name: "Recv", offbudget: false, closed: true },
    ]);

    const config: Config = {
      server: { url: "http://localhost:5006" },
      dataDir: "/tmp/ab-mirror-test",
      budgets: { alpha: { syncId: "sync-alpha", encrypted: false } },
      lookbackDays: 60,
      pipeline: [
        {
          type: "split",
          budget: "alpha",
          source: { accounts: "all", splitMirrored: false },
          tags: {
            "#50/50": {
              multiplier: -0.5,
              destination_account: "Recv",
            },
          },
        } satisfies SplitStep,
      ],
    };
    const manager = createMockManager();
    const reporter = {
      warn: vi.fn(),
      recordStep: vi.fn(),
      getSummary: vi.fn(),
      send: vi.fn(),
    };

    await runPreflight(config, manager, reporter);

    expect(reporter.warn).toHaveBeenCalledWith("preflight.emptySourceScope", {
      stepIndex: 0,
      stepType: "split",
      spec: "all",
    });
  });
});
