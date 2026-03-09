import { describe, it, expect } from "vitest";
import { parseTags, hasTags } from "../util/tags";

describe("parseTags", () => {
  it("extracts hashtags from notes", () => {
    const { tags, cleanNotes } = parseTags("Grocery run #food #joint");
    expect(tags).toEqual(["#food", "#joint"]);
    expect(cleanNotes).toBe("Grocery run");
  });

  it("handles fractional tags like #50/50", () => {
    const { tags } = parseTags("Split expense #50/50 #joint");
    expect(tags).toContain("#50/50");
    expect(tags).toContain("#joint");
  });

  it("normalises tags to lowercase", () => {
    const { tags } = parseTags("Note #Food #JOINT");
    expect(tags).toEqual(["#food", "#joint"]);
  });

  it("returns empty for null/undefined/empty notes", () => {
    expect(parseTags(null)).toEqual({ tags: [], cleanNotes: "" });
    expect(parseTags(undefined)).toEqual({ tags: [], cleanNotes: "" });
    expect(parseTags("")).toEqual({ tags: [], cleanNotes: "" });
  });

  it("collapses extra whitespace in cleanNotes", () => {
    const { cleanNotes } = parseTags("Word  #tag   another");
    expect(cleanNotes).toBe("Word another");
  });
});

describe("hasTags", () => {
  it("returns true when all required tags are present", () => {
    expect(hasTags("Note #joint #50/50", ["#joint", "#50/50"])).toBe(true);
  });

  it("returns false if any required tag is missing", () => {
    expect(hasTags("Note #joint", ["#joint", "#50/50"])).toBe(false);
  });

  it("returns true with empty required list", () => {
    expect(hasTags("Note without tags", [])).toBe(true);
    expect(hasTags(null, [])).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(hasTags("Note #JOINT", ["#joint"])).toBe(true);
  });
});
