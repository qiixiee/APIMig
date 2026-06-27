#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildGraphFromPath, summarizeGraph, analyzeProjectFromPath } from "./index.js";
import { analyzeCallsites } from "./callsite-analysis.js";

const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

// Dispatch CLI requests to either graph building or callsite analysis.
async function main() {
  const args = process.argv.slice(2);
  const summaryMode = args.includes("--summary");
  const changeSpecPath = readOption(args, "--change-spec");
  const migrationSpecPath = readOption(args, "--migration-spec");
  const executeMigration = args.includes("--execute-migration");
  const inputPath = args.find((arg) => !arg.startsWith("--"));

  if (!inputPath) {
    console.error("Usage: java-project-graph <path-to-java-file-or-directory> [--summary] [--change-spec spec.json] [--migration-spec spec.json] [--execute-migration]");
    process.exit(1);
  }

  const payload = await buildPayload({
    inputPath,
    summaryMode,
    changeSpecPath,
    migrationSpecPath,
    executeMigration,
  });

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

// Route the CLI to graph construction, callsite analysis, or migration prompt generation.
async function buildPayload({ inputPath, summaryMode, changeSpecPath, migrationSpecPath, executeMigration }) {
  if (migrationSpecPath) {
    return runPythonMigration(inputPath, migrationSpecPath, executeMigration);
  }

  if (changeSpecPath) {
    return analyzeCallsites(
      analyzeProjectFromPath(inputPath),
      JSON.parse(fs.readFileSync(changeSpecPath, "utf8")),
    );
  }

  return summarizeIfNeeded(buildGraphFromPath(inputPath), summaryMode);
}

// Delegate migration prompt/code generation to the Python implementation.
function runPythonMigration(inputPath, migrationSpecPath, executeMigration) {
  const scriptPath = path.join(CURRENT_DIRECTORY, "migration_generator.py");
  const args = [scriptPath, inputPath, "--migration-spec", migrationSpecPath];
  if (executeMigration) {
    args.push("--execute-migration");
  }

  const completed = spawnSync("python3", args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (completed.status !== 0) {
    throw new Error(completed.stderr.trim() || "Python migration generator failed");
  }

  return JSON.parse(completed.stdout);
}

// Return either the raw graph or its condensed summary view.
function summarizeIfNeeded(graph, summaryMode) {
  return summaryMode ? summarizeGraph(graph) : graph;
}

// Read a single-valued CLI option such as --change-spec.
function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  return args[index + 1] ?? null;
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? String(error));
  process.exit(1);
});
