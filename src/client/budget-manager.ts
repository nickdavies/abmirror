/**
 * Wraps @actual-app/api's budget lifecycle. Since the API only supports one
 * open budget at a time, this class tracks the currently active budget and
 * handles sync/switch transparently.
 *
 * Secrets (server password, budget encryption keys) are injected via constructor.
 */
import * as actual from "@actual-app/api";
import type { Config } from "../config/schema";
import type { Secrets } from "../env";

export interface BudgetInfo {
  alias: string;
  /** Actual's stable internal Budget ID (from metadata, survives sync resets) */
  budgetId: string;
  /** Sync ID (groupId) used for download */
  syncId: string;
}

export class BudgetManager {
  private readonly config: Config;
  private readonly secrets: Secrets;
  private readonly infos = new Map<string, BudgetInfo>();
  private openAlias: string | null = null;

  constructor(config: Config, secrets: Secrets) {
    this.config = config;
    this.secrets = secrets;
  }

  async init(opts?: { verbose?: boolean }): Promise<void> {
    await actual.init({
      dataDir: this.config.dataDir,
      serverURL: this.config.server.url,
      password: this.secrets.serverPassword,
      verbose: opts?.verbose ?? false,
    });
  }

  /**
   * Opens a budget, syncing and switching away from the current one if needed.
   * Safe to call with the already-open alias (no-op).
   */
  async open(alias: string): Promise<BudgetInfo> {
    if (this.openAlias === alias) {
      return this.getInfo(alias);
    }
    if (this.openAlias !== null) {
      await actual.sync();
    }
    return this.download(alias);
  }

  /**
   * Downloads (or re-syncs) a budget and makes it the active budget.
   * Resolves and caches the Budget ID from local metadata.
   */
  async download(alias: string): Promise<BudgetInfo> {
    const budgetConfig = this.config.budgets[alias];
    if (!budgetConfig) {
      throw new Error(`Unknown budget alias: "${alias}"`);
    }

    const encPassword = budgetConfig.encrypted
      ? this.secrets.budgetKeys[alias]
      : undefined;

    await actual.downloadBudget(budgetConfig.syncId, { password: encPassword });

    const allBudgets = await actual.getBudgets();
    const found = allBudgets.find((b) => b.groupId === budgetConfig.syncId);
    if (!found) {
      throw new Error(
        `Budget with syncId "${budgetConfig.syncId}" not found after download (alias: "${alias}")`
      );
    }
    if (!found.id) {
      throw new Error(
        `Budget "${alias}" has no local ID -- download may have failed`
      );
    }

    const info: BudgetInfo = {
      alias,
      budgetId: found.id,
      syncId: budgetConfig.syncId,
    };
    this.infos.set(alias, info);
    this.openAlias = alias;
    return info;
  }

  getInfo(alias: string): BudgetInfo {
    const info = this.infos.get(alias);
    if (!info) {
      throw new Error(`Budget "${alias}" has not been downloaded yet`);
    }
    return info;
  }

  getOpenAlias(): string | null {
    return this.openAlias;
  }

  /**
   * Syncs the currently open budget to the server. Other budgets are
   * already synced on switch via open(), so this only needs to flush
   * whatever is active right now.
   */
  async syncAll(): Promise<void> {
    if (this.openAlias) {
      await actual.sync();
    }
  }

  /** Syncs all budgets then shuts down the API. */
  async shutdown(): Promise<void> {
    await this.syncAll();
    await actual.shutdown();
  }
}
