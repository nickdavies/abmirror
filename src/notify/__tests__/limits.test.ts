import { describe, it, expect } from "vitest";
import { truncateForProvider, PROVIDER_LIMITS } from "../limits";

describe("truncateForProvider", () => {
  it("returns unchanged when within limits", () => {
    const title = "Short";
    const message = "Short message";
    const result = truncateForProvider(title, message, "pushover");
    expect(result.title).toBe(title);
    expect(result.message).toBe(message);
  });

  it("truncates title when over pushover limit", () => {
    const longTitle = "a".repeat(300);
    const result = truncateForProvider(longTitle, "msg", "pushover");
    expect(result.title.length).toBe(250);
    expect(result.title.endsWith("...")).toBe(true);
  });

  it("truncates message when over pushover limit and appends suffix", () => {
    const longMessage = "x".repeat(2000);
    const result = truncateForProvider("Title", longMessage, "pushover");
    expect(result.message.length).toBe(1024);
    expect(result.message).toContain("(truncated, see logs for full report)");
  });

  it("uses default provider limits when provider is default", () => {
    const longMessage = "x".repeat(5000);
    const result = truncateForProvider("Title", longMessage, "default");
    expect(result.message.length).toBe(4096);
    expect(result.message).toContain("(truncated, see logs for full report)");
  });
});
