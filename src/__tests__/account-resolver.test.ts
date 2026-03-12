import { describe, it, expect } from "vitest";
import {
  checkDuplicateNames,
  formatDuplicateErrorForUser,
  resolveAccountsSpec,
  resolveAccountId,
} from "../util/account-resolver";
import type { ActualAccount } from "../selector/types";

const mkAccount = (
  id: string,
  name: string,
  opts: Partial<ActualAccount> = {}
): ActualAccount => ({ id, name, offbudget: false, closed: false, ...opts });

describe("checkDuplicateNames", () => {
  it("returns null when all names are unique", () => {
    const accounts = [
      mkAccount("id-1", "Checking"),
      mkAccount("id-2", "Savings"),
    ];
    expect(checkDuplicateNames(accounts, "alpha")).toBeNull();
  });

  it("returns first duplicate when names repeat", () => {
    const accounts = [
      mkAccount("id-1", "Checking"),
      mkAccount("id-2", "Checking"),
    ];
    const dup = checkDuplicateNames(accounts, "alpha");
    expect(dup).not.toBeNull();
    expect(dup!.name).toBe("Checking");
    expect(dup!.budget).toBe("alpha");
    expect(dup!.accounts).toHaveLength(2);
    expect(dup!.accounts.map((a) => a.id)).toContain("id-1");
    expect(dup!.accounts.map((a) => a.id)).toContain("id-2");
  });
});

describe("formatDuplicateErrorForUser", () => {
  it("includes ids and basic info for each duplicate account", () => {
    const dup = {
      budget: "alpha",
      name: "Checking",
      accounts: [
        mkAccount("uuid-1", "Checking", { offbudget: false, closed: false }),
        mkAccount("uuid-2", "Checking", { offbudget: true, closed: false }),
      ],
    };
    const out = formatDuplicateErrorForUser(dup);
    expect(out).toContain('Duplicate account name "Checking"');
    expect(out).toContain("id: uuid-1");
    expect(out).toContain("id: uuid-2");
    expect(out).toContain("on-budget");
    expect(out).toContain("off-budget");
  });
});

describe("resolveAccountsSpec", () => {
  const CHECKING_UUID = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
  const SAVINGS_UUID = "b2c3d4e5-f6a7-4890-b123-456789abcdef";
  const accounts = [
    mkAccount(CHECKING_UUID, "Checking"),
    mkAccount(SAVINGS_UUID, "Savings"),
  ];

  it("passes through scope keywords", () => {
    expect(resolveAccountsSpec(accounts, "all", "alpha")).toEqual({
      ok: true,
      spec: "all",
    });
    expect(resolveAccountsSpec(accounts, "on-budget", "alpha")).toEqual({
      ok: true,
      spec: "on-budget",
    });
    expect(resolveAccountsSpec(accounts, "off-budget", "alpha")).toEqual({
      ok: true,
      spec: "off-budget",
    });
  });

  it("resolves name to id for single string", () => {
    const result = resolveAccountsSpec(accounts, "Checking", "alpha");
    expect(result.ok).toBe(true);
    expect(result.spec).toBe(CHECKING_UUID);
  });

  it("passes through UUID that exists", () => {
    const result = resolveAccountsSpec(accounts, CHECKING_UUID, "alpha");
    expect(result.ok).toBe(true);
    expect(result.spec).toBe(CHECKING_UUID);
  });

  it("resolves array of names to ids", () => {
    const result = resolveAccountsSpec(accounts, ["Checking", "Savings"], "alpha");
    expect(result.ok).toBe(true);
    expect(result.spec).toEqual([CHECKING_UUID, SAVINGS_UUID]);
  });

  it("fails for unknown name", () => {
    const result = resolveAccountsSpec(accounts, "Unknown", "alpha");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown");
    expect(result.error).toContain("alpha");
  });

  it("fails for unknown UUID", () => {
    const result = resolveAccountsSpec(accounts, "00000000-0000-0000-0000-000000000000", "alpha");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("00000000-0000-0000-0000-000000000000");
  });
});

describe("resolveAccountId", () => {
  const CHECKING_UUID = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
  const accounts = [
    mkAccount(CHECKING_UUID, "Checking"),
    mkAccount("b2c3d4e5-f6a7-4890-b123-456789abcdef", "Savings"),
  ];

  it("resolves name to id", () => {
    const result = resolveAccountId(accounts, "Checking", "alpha");
    expect(result.ok).toBe(true);
    expect(result.ok && result.id).toBe(CHECKING_UUID);
  });

  it("passes through UUID that exists", () => {
    const result = resolveAccountId(accounts, CHECKING_UUID, "alpha");
    expect(result.ok).toBe(true);
    expect(result.ok && result.id).toBe(CHECKING_UUID);
  });

  it("fails for unknown name", () => {
    const result = resolveAccountId(accounts, "Unknown", "alpha");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("Unknown");
  });
});
