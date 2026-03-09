/**
 * Wraps @actual-app/api's budget lifecycle. Since the API only supports one
 * open budget at a time, this class tracks the currently active budget and
 * handles sync/switch transparently.
 *
 * Encryption keys per budget come from env: AB_MIRROR_KEY_<ALIAS_UPPERCASED>
 * Server password comes from env: AB_MIRROR_SERVER_PASSWORD
 */
import * as actual from "@actual-app/api";
import type { Config } from "../config/schema";

export interface BudgetInfo {
  alias: string;
  /** Actual's stable internal Budget ID (from metadata, survives sync resets) */
  budgetId: string;
  /** Sync ID (groupId) used for download */
  syncId: string;
}

export class BudgetManager {
  private readonly config: Config;
  private readonly infos = new Map<string, BudgetInfo>();
  private openAlias: string | null = null;
  private readonly dirty = new Set<string>();

  constructor(config: Config) {
    this.config = config;
  }

  async init(): Promise<void> {
    const serverPassword = process.env["AB_MIRROR_SERVER_PASSWORD"];
    await actual.init({
      dataDir: this.config.dataDir,
      serverURL: this.config.server.url,
      password: serverPassword,
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
      // Sync before switching so changes aren't lost
      await actual.sync();
      this.dirty.delete(this.openAlias);
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
      ? process.env[`AB_MIRROR_KEY_${alias.toUpperCase().replace(/-/g, "_")}`]
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

  /** Call after writing transactions to a budget so syncAll knows to include it. */
  markDirty(alias: string): void {
    this.dirty.add(alias);
  }

  getOpenAlias(): string | null {
    return this.openAlias;
  }

  /**
   * Syncs all dirty budgets to the server. The currently open budget is synced
   * first; remaining dirty budgets are opened, synced, then left open (the last
   * one becomes the active budget). After this call dirty set is empty.
   */
  async syncAll(): Promise<void> {
    if (this.openAlias && this.dirty.has(this.openAlias)) {
      await actual.sync();
      this.dirty.delete(this.openAlias);
    }

    for (const alias of [...this.dirty]) {
      await this.download(alias); // switches to this budget (syncs from server)
      await actual.sync(); // push our local writes
      this.dirty.delete(alias);
    }
  }

  /** Syncs all dirty budgets then shuts down the API. */
  async shutdown(): Promise<void> {
    await this.syncAll();
    await actual.shutdown();
  }
}
