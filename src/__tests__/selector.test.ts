import { describe, it, expect } from "vitest";
import { selectAccounts, selectTransactions } from "../selector/index";
import type { ActualAccount, ActualTransaction } from "../selector/types";

const mkAccount = (
  id: string,
  opts: Partial<ActualAccount> = {}
): ActualAccount => ({ id, name: id, offbudget: false, closed: false, ...opts });

const mkTx = (
  id: string,
  opts: Partial<ActualTransaction> = {}
): ActualTransaction => ({
  id,
  account: "acct-1",
  date: "2025-01-15",
  amount: -1000,
  ...opts,
});

describe("selectAccounts", () => {
  const accounts: ActualAccount[] = [
    mkAccount("a1"),
    mkAccount("a2", { offbudget: true }),
    mkAccount("a3", { closed: true }),
  ];

  it("all excludes closed", () => {
    const result = selectAccounts(accounts, "all");
    expect(result.map((a) => a.id)).toEqual(["a1", "a2"]);
  });

  it("on-budget filters to non-offbudget open accounts", () => {
    const result = selectAccounts(accounts, "on-budget");
    expect(result.map((a) => a.id)).toEqual(["a1"]);
  });

  it("off-budget filters to offbudget open accounts", () => {
    const result = selectAccounts(accounts, "off-budget");
    expect(result.map((a) => a.id)).toEqual(["a2"]);
  });

  it("array spec excludes closed accounts", () => {
    const result = selectAccounts(accounts, ["a1", "a3"]);
    expect(result.map((a) => a.id)).toEqual(["a1"]);
  });

  it("string spec matches single account id", () => {
    const result = selectAccounts(accounts, "a2");
    expect(result.map((a) => a.id)).toEqual(["a2"]);
  });

  it("excludeIds filters out accounts from result", () => {
    const result = selectAccounts(accounts, "all", new Set(["a1"]));
    expect(result.map((a) => a.id)).toEqual(["a2"]);
  });

  it("excludeIds with on-budget excludes dest from source scope", () => {
    const result = selectAccounts(accounts, "on-budget", new Set(["a1"]));
    expect(result.map((a) => a.id)).toEqual([]);
  });
});

describe("selectTransactions", () => {
  it("yields normal transactions that pass requiredTags", () => {
    const txs = [
      mkTx("t1", { notes: "#joint buy stuff" }),
      mkTx("t2", { notes: "no tags" }),
    ];
    const result = [...selectTransactions(txs, { accounts: "all", requiredTags: ["#joint"] })];
    expect(result.map((t) => t.id)).toEqual(["t1"]);
  });

  it("skips is_child top-level entries", () => {
    const txs = [mkTx("t1", { is_child: true, notes: "#joint" })];
    const result = [...selectTransactions(txs, { accounts: "all" })];
    expect(result).toHaveLength(0);
  });

  it("yields matching subtransactions from split parents", () => {
    const txs = [
      mkTx("parent", {
        is_parent: true,
        notes: "parent note",
        subtransactions: [
          mkTx("sub1", { id: "sub1", notes: "#joint buy", amount: -500 }),
          mkTx("sub2", { id: "sub2", notes: "no tag", amount: -500 }),
        ],
      }),
    ];
    const result = [...selectTransactions(txs, { accounts: "all", requiredTags: ["#joint"] })];
    expect(result.map((t) => t.id)).toEqual(["sub1"]);
  });

  it("yields all subtransactions when no requiredTags", () => {
    const txs = [
      mkTx("parent", {
        is_parent: true,
        subtransactions: [
          mkTx("sub1", { id: "sub1" }),
          mkTx("sub2", { id: "sub2" }),
        ],
      }),
    ];
    const result = [...selectTransactions(txs, { accounts: "all" })];
    expect(result.map((t) => t.id)).toEqual(["sub1", "sub2"]);
  });
});
