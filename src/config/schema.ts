/**
 * YAML config schema. Secrets can be provided via ${VAR} substitution in the
 * config file (server.password, budgets[].key, notify.pushover) or via env vars.
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
    splitMirrored: z.boolean().default(false),
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

const NotifyPushoverSchema = z
  .object({
    user: z.string().min(1).optional(),
    token: z.string().min(1).optional(),
  })
  .optional();

const NotifySchema = z
  .object({
    onSuccess: z.boolean().default(false),
    pushover: NotifyPushoverSchema,
  })
  .optional();

export const ConfigSchema = z.object({
  server: z.object({
    url: z.string().url(),
    password: z
      .string()
      .optional()
      .refine((v) => v === undefined || v.length > 0, {
        message: "server.password when present must be non-empty",
      }),
  }),
  dataDir: z.string().min(1),
  budgets: z.record(
    z.string().min(1),
    z.object({
      syncId: z.string().min(1),
      encrypted: z.boolean().default(false),
      key: z.string().min(1).optional(),
    })
  ),
  pipeline: z.array(PipelineStepSchema).default([]),
  lookbackDays: z.number().int().positive().default(60),
  notify: NotifySchema,
});

export type Config = z.infer<typeof ConfigSchema>;
export type PipelineStep = z.infer<typeof PipelineStepSchema>;
export type SplitStep = z.infer<typeof SplitStepSchema>;
export type MirrorStep = z.infer<typeof MirrorStepSchema>;
export type AccountsSpec = z.infer<typeof AccountsSpecSchema>;
export type TagAction = z.infer<typeof TagActionSchema>;
