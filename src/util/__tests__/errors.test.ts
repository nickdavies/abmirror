import { describe, it, expect } from "vitest";
import { enhanceDownloadError } from "../errors";

describe("enhanceDownloadError", () => {
  it("enhances 'Could not get remote files' with troubleshooting hints", () => {
    const err = new Error("Could not get remote files");
    const enhanced = enhanceDownloadError(err, "https://sync.example.com");
    expect(enhanced.message).toContain("Could not get remote files");
    expect(enhanced.message).toContain("Common causes:");
    expect(enhanced.message).toContain("AB_MIRROR_SERVER_PASSWORD");
    expect(enhanced.message).toContain("list-budgets --server https://sync.example.com");
  });

  it("does not double-enhance an already enhanced error", () => {
    const err = new Error("Could not get remote files\n\nCommon causes:");
    const enhanced = enhanceDownloadError(err);
    expect(enhanced).toBe(err);
  });

  it("returns original error for unrelated messages", () => {
    const err = new Error("Something else went wrong");
    const enhanced = enhanceDownloadError(err);
    expect(enhanced).toBe(err);
    expect(enhanced.message).toBe("Something else went wrong");
  });

  it("works without serverUrl (generic debug hint)", () => {
    const err = new Error("Could not get remote files");
    const enhanced = enhanceDownloadError(err);
    expect(enhanced.message).toContain("list-budgets --server <url>");
  });
});
