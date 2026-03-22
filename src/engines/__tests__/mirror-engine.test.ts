import { describe, it, expect } from "vitest";
import { createMirrorEngine } from "../mirror-engine";
import { formatImportedId } from "../../util/imported-id";
import type { ActualTransaction, NewTransaction } from "../../selector/types";
import type { MirrorStep } from "../../config/schema";

const SOURCE_BUDGET = "source-budget";
const DEST_BUDGET = "dest-budget";
const DEST_ACCOUNT = "dest-acct-id";

const baseStep: MirrorStep = {
  type: "mirror",
  source: { budget: "src", accounts: "all" },
  destination: { budget: "dst", account: DEST_ACCOUNT },
  invert: false,
  delete: false,
  updateFields: false,
};

const mkTx = (id: string, overrides: Partial<ActualTransaction> = {}): ActualTransaction => ({
  id,
  account: "src-acct",
  date: "2025-01-15",
  amount: -10000,
  notes: null,
  category: null,
  ...overrides,
});

const baseOpts = {
  sourceBudgetAlias: "src",
  sourceBudgetId: SOURCE_BUDGET,
  sourceAccountsSpec: "all" as const,
  destBudgetAlias: "dst",
  destBudgetId: DEST_BUDGET,
  destAccountIds: [DEST_ACCOUNT],
  startDate: "2024-11-17",
  endDate: "2025-01-15",
  dryRun: false,
  stepType: "mirror" as const,
};

describe("createMirrorEngine", () => {
  describe("round-trip detection", () => {
    it("skips mirroring when source imported_id points to dest budget (avoids loop)", () => {
      const engine = createMirrorEngine(baseStep);
      const sourceTx = mkTx("source-tx-id", {
        imported_id: formatImportedId(DEST_BUDGET, "tx-origin"),
      });
      const { desired } = engine.propose([sourceTx], baseOpts);
      expect(desired.has("tx-origin:dest-acct-id")).toBe(false);
      expect(desired.size).toBe(0);
    });

    it("skips when source imported_id points to dest budget (same-budget)", () => {
      const engine = createMirrorEngine(baseStep);
      const sourceTx = mkTx("source-tx-id", {
        imported_id: formatImportedId(DEST_BUDGET, "tx-origin"),
      });
      const opts = { ...baseOpts, sourceBudgetId: DEST_BUDGET, destBudgetId: DEST_BUDGET };
      const { desired } = engine.propose([sourceTx], opts);
      expect(desired.has("tx-origin:dest-acct-id")).toBe(false);
      expect(desired.size).toBe(0);
    });

    it("uses canonical key when source imported_id points to other budget (same-budget mirror dedup)", () => {
      const engine = createMirrorEngine(baseStep);
      const sourceTx = mkTx("source-tx-id", {
        imported_id: formatImportedId("OtherBudget", "tx-1"),
      });
      const { desired } = engine.propose([sourceTx], baseOpts);
      expect(desired.has("tx-1:dest-acct-id")).toBe(true);
      expect(desired.has("source-tx-id:dest-acct-id")).toBe(false);
    });

    it("uses normal key when source has null imported_id", () => {
      const engine = createMirrorEngine(baseStep);
      const sourceTx = mkTx("source-tx-id", { imported_id: undefined });
      const { desired } = engine.propose([sourceTx], baseOpts);
      expect(desired.has("source-tx-id:dest-acct-id")).toBe(true);
    });

    it("uses normal key when source has non-ABMirror imported_id", () => {
      const engine = createMirrorEngine(baseStep);
      const sourceTx = mkTx("source-tx-id", { imported_id: "OFXIMPORT:123" });
      const { desired } = engine.propose([sourceTx], baseOpts);
      expect(desired.has("source-tx-id:dest-acct-id")).toBe(true);
    });

    it("skips when source imported_id points to dest (split output round-trip)", () => {
      const engine = createMirrorEngine(baseStep);
      const sourceTx = mkTx("split-output-id", {
        imported_id: formatImportedId("joint-budget", "Tx-1"),
      });
      const opts = { ...baseOpts, destBudgetId: "joint-budget" };
      const { desired } = engine.propose([sourceTx], opts);
      expect(desired.has("Tx-1:dest-acct-id")).toBe(false);
      expect(desired.size).toBe(0);
    });

    it("skips when source imported_id points to dest (mirror output round-trip)", () => {
      const engine = createMirrorEngine(baseStep);
      const sourceTx = mkTx("mirror-output-id", {
        imported_id: formatImportedId("joint-budget", "Tx-J2"),
      });
      const opts = { ...baseOpts, destBudgetId: "joint-budget" };
      const { desired } = engine.propose([sourceTx], opts);
      expect(desired.has("Tx-J2:dest-acct-id")).toBe(false);
      expect(desired.size).toBe(0);
    });
  });

  describe("mixed source txs", () => {
    it("two source txs: one round-trip (skipped), one normal -> desired has only normal", () => {
      const engine = createMirrorEngine(baseStep);
      const roundTripTx = mkTx("rt-id", {
        imported_id: formatImportedId(DEST_BUDGET, "tx-origin"),
      });
      const normalTx = mkTx("normal-id", { imported_id: undefined });
      const { desired } = engine.propose([roundTripTx, normalTx], baseOpts);
      expect(desired.has("tx-origin:dest-acct-id")).toBe(false);
      expect(desired.has("normal-id:dest-acct-id")).toBe(true);
      expect(desired.size).toBe(1);
    });
  });

  describe("invert mode", () => {
    it("skips round-trip even with invert (do not mirror back to origin)", () => {
      const step = { ...baseStep, invert: true };
      const engine = createMirrorEngine(step);
      const sourceTx = mkTx("source-id", {
        amount: -5000,
        imported_id: formatImportedId(DEST_BUDGET, "tx-origin"),
      });
      const { desired } = engine.propose([sourceTx], baseOpts);
      expect(desired.has("tx-origin:dest-acct-id")).toBe(false);
      expect(desired.size).toBe(0);
    });
  });

  describe("normal (non-round-trip) behavior", () => {
    it("sets imported_id to formatImportedId(sourceBudgetId, sourceTx.id)", () => {
      const engine = createMirrorEngine(baseStep);
      const sourceTx = mkTx("src-1");
      const { desired } = engine.propose([sourceTx], baseOpts);
      const entry = desired.get("src-1:dest-acct-id");
      expect(entry?.tx.imported_id).toBe(formatImportedId(SOURCE_BUDGET, "src-1"));
    });
  });

  describe("round-trip imported_id", () => {
    it("does not propose when source imported_id points to dest (no mirror-back)", () => {
      const engine = createMirrorEngine(baseStep);
      const sourceTx = mkTx("alpha-tx-id", {
        imported_id: formatImportedId(DEST_BUDGET, "beta-origin-tx"),
      });
      const { desired } = engine.propose([sourceTx], baseOpts);
      expect(desired.has("beta-origin-tx:dest-acct-id")).toBe(false);
    });
  });
});
