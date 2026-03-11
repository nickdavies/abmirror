/**
 * YAML config schema. Secrets (server password, budget encryption keys) are
 * never stored here -- they come from env vars at runtime.
 */
import { z } from "zod";

// "all", "on-budget", "off-budget", a single account ID, or a list of IDs
const AccountsSpecSchema = z.union([
  z.literal("all"),
  z.literal("on-budget"),
  z.literal("off-budget"),
  z.array(z.string().min(1)),
  z.string().min(1),
]);

const TagActionSchema = z.object({
  multiplier: z.number(),
  destination_account: z.string().min(1),
});

export const SplitStepSchema = z.object({
  type: z.literal("split"),
  budget: z.string().min(1),
  source: z.object({
    accounts: AccountsSpecSchema.default("all"),
    requiredTags: z.array(z.string().min(1)).optional(),
  }),
  tags: z.record(z.string().min(1), TagActionSchema),
});

export const MirrorStepSchema = z.object({
  type: z.literal("mirror"),
  source: z.object({
    budget: z.string().min(1),
    accounts: AccountsSpecSchema.default("all"),
    requiredTags: z.array(z.string().min(1)).optional(),
  }),
  destination: z.object({
    budget: z.string().min(1),
    account: z.string().min(1),
  }),
  invert: z.boolean().default(false),
  delete: z.boolean().default(false),
  copyMirrored: z.boolean().default(false),
  categoryMapping: z.record(z.string(), z.string()).optional(),
});

export const PipelineStepSchema = z.discriminatedUnion("type", [
  SplitStepSchema,
  MirrorStepSchema,
]);

export const ConfigSchema = z.object({
  server: z.object({
    url: z.string().url(),
  }),
  dataDir: z.string().min(1),
  budgets: z.record(
    z.string().min(1),
    z.object({
      syncId: z.string().min(1),
      encrypted: z.boolean().default(false),
    })
  ),
  pipeline: z.array(PipelineStepSchema).min(1),
  lookbackDays: z.number().int().positive().default(60),
});

export type Config = z.infer<typeof ConfigSchema>;
export type PipelineStep = z.infer<typeof PipelineStepSchema>;
export type SplitStep = z.infer<typeof SplitStepSchema>;
export type MirrorStep = z.infer<typeof MirrorStepSchema>;
export type AccountsSpec = z.infer<typeof AccountsSpecSchema>;
export type TagAction = z.infer<typeof TagActionSchema>;
