/**
 * Shared mutable state for the @actual-app/api mock used in YAML-based tests.
 *
 * The mock factory (vi.mock) and MockBudgetManager both import this module so
 * they operate on the same object. Tests call setMockEnv() before each run.
 */
import type { RuntimeEnv } from "./runtime";

export type MockState = {
  env: RuntimeEnv | null;
  /** Alias of the currently "open" budget (updated by MockBudgetManager.open). */
  openAlias: string | null;
  /** Counts how many add/update/delete operations happened in the current round. */
  changeCount: number;
};

export const mockState: MockState = {
  env: null,
  openAlias: null,
  changeCount: 0,
};

export function setMockEnv(env: RuntimeEnv): void {
  mockState.env = env;
  mockState.openAlias = null;
  mockState.changeCount = 0;
}

export function resetChangeCount(): void {
  mockState.changeCount = 0;
}
