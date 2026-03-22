#!/usr/bin/env npx tsx
/**
 * Merge base config with pipeline YAML. Writes result to stdout or a file.
 * Usage: merge-config.ts <base-config> <pipeline-file> [output-file]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";

const [basePath, pipelinePath, outPath] = process.argv.slice(2);
if (!basePath || !pipelinePath) {
  console.error("Usage: merge-config.ts <base-config> <pipeline-file> [output-file]");
  process.exit(1);
}

const base = parse(readFileSync(basePath, "utf-8"));
const pipelineDoc = parse(readFileSync(pipelinePath, "utf-8"));
base.pipeline = pipelineDoc.pipeline ?? pipelineDoc;

const yaml = stringify(base);
if (outPath) {
  writeFileSync(outPath, yaml, "utf-8");
} else {
  process.stdout.write(yaml);
}
