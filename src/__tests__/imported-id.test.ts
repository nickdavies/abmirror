import { describe, it, expect } from "vitest";
import {
  formatImportedId,
  parseImportedId,
  isABMirrorId,
  getRootTxId,
} from "../util/imported-id";

describe("formatImportedId", () => {
  it("produces the correct prefix:budgetId:txId format", () => {
    expect(formatImportedId("Budget-abc123", "tx-xyz")).toBe(
      "ABMirror:Budget-abc123:tx-xyz"
    );
  });
});

describe("isABMirrorId", () => {
  it("recognises valid ABMirror IDs", () => {
    expect(isABMirrorId("ABMirror:budget:tx")).toBe(true);
  });

  it("rejects unrelated strings", () => {
    expect(isABMirrorId("OFXIMPORT:123")).toBe(false);
    expect(isABMirrorId(null)).toBe(false);
    expect(isABMirrorId(undefined)).toBe(false);
    expect(isABMirrorId("")).toBe(false);
  });
});

describe("getRootTxId", () => {
  it("returns plain tx id unchanged", () => {
    expect(getRootTxId("some-uuid-1234")).toBe("some-uuid-1234");
  });

  it("strips ::default::<destAcctId> suffix", () => {
    expect(getRootTxId("some-uuid-1234::default::acct-abc")).toBe("some-uuid-1234");
  });

  it("strips suffix even when dest account ID contains colons", () => {
    expect(getRootTxId("tx-1::default::acct:with:colons")).toBe("tx-1");
  });
});

describe("parseImportedId", () => {
  it("round-trips through format/parse", () => {
    const budgetId = "My-Budget-a3f9c12";
    const txId = "some-uuid-here";
    const raw = formatImportedId(budgetId, txId);
    const parsed = parseImportedId(raw);
    expect(parsed).toEqual({ budgetId, txId });
  });

  it("returns null for non-ABMirror strings", () => {
    expect(parseImportedId("something-else")).toBeNull();
    expect(parseImportedId("ABMirror:nocolon")).toBeNull();
  });

  it("handles txId that contains colons", () => {
    // Budget IDs use hyphens, but txIds could theoretically have colons
    const raw = "ABMirror:MyBudget:tx:with:colons";
    const parsed = parseImportedId(raw);
    expect(parsed?.budgetId).toBe("MyBudget");
    expect(parsed?.txId).toBe("tx:with:colons");
  });
});
