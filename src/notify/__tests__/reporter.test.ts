import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRunReporter } from "../reporter";

const mockConfig = {
  server: { url: "http://localhost:5006" },
  dataDir: "/tmp/test",
  budgets: {},
  pipeline: [],
  lookbackDays: 60,
  maxChangesPerStep: 100,
  notify: undefined,
};

describe("createRunReporter", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  it("formats summary with steps and warnings", () => {
    const reporter = createRunReporter(mockConfig);
    reporter.recordStep({ type: "split", added: 2, updated: 1 });
    reporter.recordStep({ type: "mirror", added: 5, updated: 0, deleted: 1 });
    reporter.warn("splitter.multiTagMatch", {
      payee: "Coffee",
      date: "2025-03-14",
      matchingTags: ["#50/50", "#0/100"],
    });

    const summary = reporter.getSummary();
    expect(summary.steps).toHaveLength(2);
    expect(summary.steps[0]).toEqual({ type: "split", added: 2, updated: 1 });
    expect(summary.steps[1]).toEqual({
      type: "mirror",
      added: 5,
      updated: 0,
      deleted: 1,
    });
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]?.code).toBe("splitter.multiTagMatch");
  });

  it("does not send when notify not configured", () => {
    const reporter = createRunReporter(mockConfig);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    reporter.send(true);
    expect(logSpy).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("sends to Pushover when configured and has warnings", async () => {
    const configWithNotify = {
      ...mockConfig,
      notify: {
        onSuccess: false,
        pushover: { user: "u1", token: "t1" },
      },
    };
    const reporter = createRunReporter(configWithNotify);
    reporter.warn("preflight.emptySourceScope", {
      stepIndex: 0,
      stepType: "split",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    reporter.send(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.pushover.net/1/messages.json",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      })
    );
    const body = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]
      ?.body as string;
    expect(body).toContain("user=u1");
    expect(body).toContain("token=t1");
    expect(body).toContain("source+scope+matched+no+accounts");
    logSpy.mockRestore();
  });

  it("does not send on clean success when onSuccess is false", () => {
    const configWithNotify = {
      ...mockConfig,
      notify: {
        onSuccess: false,
        pushover: { user: "u1", token: "t1" },
      },
    };
    const reporter = createRunReporter(configWithNotify);
    reporter.recordStep({ type: "split", added: 0, updated: 0 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    reporter.send(true);
    expect(fetch).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("sends on clean success when onSuccess is true", () => {
    const configWithNotify = {
      ...mockConfig,
      notify: {
        onSuccess: true,
        pushover: { user: "u1", token: "t1" },
      },
    };
    const reporter = createRunReporter(configWithNotify);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    reporter.send(true);
    expect(fetch).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
