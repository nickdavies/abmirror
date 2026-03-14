/** Public library API for programmatic use. */
export { loadConfig } from "./config/loader";
export type { Config, PipelineStep, SplitStep, MirrorStep } from "./config/schema";

export { loadSecrets, envKeyForBudget } from "./env";
export type { Secrets } from "./env";

export { BudgetManager } from "./client/budget-manager";
export type { BudgetInfo } from "./client/budget-manager";

export { runPipeline, validateConfig } from "./orchestrator/index";
export type { RunOptions } from "./orchestrator/index";

export { runSyncer, computeSyncDiff } from "./syncer/index";
export type { SyncerOptions, SyncDiff } from "./syncer/index";

export { runSplitter, computeSplitDiff } from "./splitter/index";
export type { SplitterOptions, SplitDiff } from "./splitter/index";

export { formatImportedId, parseImportedId, isABMirrorId } from "./util/imported-id";
export { parseTags, hasTags } from "./util/tags";
