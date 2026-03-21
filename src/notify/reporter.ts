/**
 * Run reporter: collects warnings during pipeline execution, formats a summary,
 * always logs full report to console, and optionally sends via Pushover.
 */
import type { Config } from "../config/schema";
import { truncateForProvider } from "./limits";

export type WarningCode =
  | "splitter.multiTagMatch"
  | "splitter.scopeMatchNoActionTag"
  | "preflight.closedAccountInScope"
  | "preflight.emptySourceScope"
  | "sync.highChangeCount";

export interface Warning {
  code: WarningCode;
  detail: unknown;
}

export interface StepResult {
  type: "split" | "mirror";
  added: number;
  updated: number;
  deleted?: number;
}

export interface RunSummary {
  success: boolean;
  durationMs: number;
  steps: StepResult[];
  warnings: Warning[];
}

function formatWarning(code: WarningCode, detail: unknown): string {
  switch (code) {
    case "splitter.multiTagMatch": {
      const d = detail as {
        payee?: string;
        date?: string;
        matchingTags?: string[];
      };
      const payee = d.payee ?? "?";
      const date = d.date ?? "?";
      const tags = (d.matchingTags ?? []).join(", ");
      return `Multi-tag: "${payee}" (${date}) – skipped, couldn't handle (matched: ${tags})`;
    }
    case "splitter.scopeMatchNoActionTag": {
      const d = detail as { stepIndex?: number; count?: number };
      const step = (d.stepIndex ?? 0) + 1;
      const count = d.count ?? 0;
      return `Scope match, no action tag: ${count} transactions skipped (step ${step})`;
    }
    case "preflight.closedAccountInScope": {
      const d = detail as { stepIndex?: number; budget?: string; accountName?: string };
      const step = (d.stepIndex ?? 0) + 1;
      const budget = d.budget ?? "?";
      const name = d.accountName ?? "?";
      return `Closed account "${name}" in step ${step} (budget ${budget})`;
    }
    case "preflight.emptySourceScope": {
      const d = detail as { stepIndex?: number; stepType?: string };
      const step = (d.stepIndex ?? 0) + 1;
      const type = d.stepType ?? "?";
      return `Step ${step} (${type}): source scope matched no accounts`;
    }
    case "sync.highChangeCount": {
      const d = detail as { stepIndex?: number; total?: number; added?: number; updated?: number; deleted?: number };
      const step = (d.stepIndex ?? 0) + 1;
      return `Step ${step}: high change count (${d.total ?? 0}: +${d.added ?? 0} ~${d.updated ?? 0} -${d.deleted ?? 0})`;
    }
    default:
      return `[${code}] ${JSON.stringify(detail)}`;
  }
}

function formatMessage(summary: RunSummary): string {
  const lines: string[] = [];
  for (const step of summary.steps) {
    const parts: string[] = [];
    if (step.added > 0) parts.push(`+${step.added}`);
    if (step.updated > 0) parts.push(`${step.updated} updated`);
    if (step.deleted !== undefined && step.deleted > 0) parts.push(`${step.deleted} deleted`);
    if (parts.length > 0) {
      lines.push(`${step.type}: ${parts.join(" ")}`);
    }
  }
  for (const w of summary.warnings) {
    lines.push(formatWarning(w.code, w.detail));
  }
  return lines.length > 0 ? lines.join("\n") : "No changes.";
}

export interface RunReporter {
  warn(code: WarningCode, detail: unknown): void;
  recordStep(result: StepResult): void;
  getSummary(): RunSummary;
  send(success: boolean): Promise<void>;
}

export function createRunReporter(
  config: Config,
  opts: { startTime?: number } = {}
): RunReporter {
  const startTime = opts.startTime ?? Date.now();
  const warnings: Warning[] = [];
  const steps: StepResult[] = [];

  return {
    warn(code: WarningCode, detail: unknown) {
      warnings.push({ code, detail });
    },

    recordStep(result: StepResult) {
      steps.push(result);
    },

    getSummary(): RunSummary {
      return {
        success: true,
        durationMs: Date.now() - startTime,
        steps,
        warnings,
      };
    },

    async send(success: boolean) {
      const summary: RunSummary = {
        success,
        durationMs: Date.now() - startTime,
        steps,
        warnings,
      };
      const title = success ? "AB Mirror: Success" : "AB Mirror: Failed";
      const fullMessage = formatMessage(summary);

      // Always log full report to console
      console.log(`\n--- AB Mirror Report ---`);
      console.log(`${title} (${(summary.durationMs / 1000).toFixed(1)}s)`);
      console.log(fullMessage);
      console.log("------------------------\n");

      const pushover = config.notify?.pushover;
      const user = pushover?.user;
      const token = pushover?.token;
      const onSuccess = config.notify?.onSuccess ?? false;

      const shouldSend =
        user &&
        token &&
        (!success || summary.warnings.length > 0 || onSuccess);

      if (!shouldSend) return;

      const { title: truncatedTitle, message: truncatedMsg } = truncateForProvider(
        title,
        fullMessage,
        "pushover"
      );

      const body = new URLSearchParams({
        token,
        user,
        title: truncatedTitle,
        message: truncatedMsg,
        ...(success ? {} : { priority: "1" }),
      });

      try {
        await fetch("https://api.pushover.net/1/messages.json", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });
      } catch (err) {
        console.error("Pushover send failed:", err);
      }
    },
  };
}
