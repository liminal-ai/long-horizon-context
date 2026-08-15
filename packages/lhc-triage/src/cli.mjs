#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  openThread,
  readChunk,
  readIssues,
  readSummaries,
  readSummary,
  readTurn,
} from "./thread-reader.mjs";

const HELP = `lhc-triage — read-only LHC thread traversal

Usage:
  lhc-triage <thread.sqlite> summary [--json]
  lhc-triage <thread.sqlite> issues [--json]
  lhc-triage <thread.sqlite> summaries [--type <all|turn|turn-rendering|chunk-detailed|chunk-brief>] [--state <state>] [--limit N] [--offset N] [--max-chars N] [--json]
  lhc-triage <thread.sqlite> show turn <tN> [--max-chars N] [--json]
  lhc-triage <thread.sqlite> show chunk <cN> [--max-chars N] [--json]

The CLI opens SQLite in read-only and query-only mode. It does not enqueue,
derive, compact, repair, or modify agent records.`;

function parseOptions(args) {
  const positional = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === "json") {
      options.json = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return { positional, options };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printSummary(value) {
  console.log(`Thread: ${value.filePath}`);
  console.log(`SQLite: integrity=${value.integrity} schema=${value.userVersion}`);
  console.log(
    `Archive: events=${value.events.count} maxEvent=${value.events.maxEventOrder} turns=${value.turns.live} live (${value.turns.closed} closed, ${value.turns.open} open)`,
  );
  if (value.view === null) {
    console.log("View: none");
  } else {
    console.log(
      `View: ${value.view.viewId} point=${value.view.compactPoint} entries=${value.view.arrangementEntries} degraded=${value.view.degradedEntries} gaps=${value.view.gapEntries}`,
    );
    console.log(`View config: ${JSON.stringify(value.view.config)}`);
  }
  for (const band of value.bands) {
    console.log(`Band ${band.band}: ${band.tokenCount} tokens · ${band.characters} chars`);
  }
  const problems = Object.fromEntries(value.currentProblemCounts.map((item) => [item.state, item.count]));
  console.log(
    `Current health: failed=${problems.failed ?? 0} blocked=${problems.blocked ?? 0} activeWork=${value.activeWork.length}`,
  );
  if (value.view?.sourceStateAtViewCreation) {
    console.log("Note: view source-state counts are historical evidence from view creation, not current health.");
  }
}

function printIssues(value) {
  console.log(`Current failed/blocked: ${value.failedOrBlocked.length}`);
  for (const item of value.failedOrBlocked) {
    console.log(`  ${item.state} ${item.subjectKind}/${item.subjectId}/${item.derivationType} v${item.sourceVersion}: ${item.reason ?? ""}`);
  }
  console.log(`Active work: ${value.activeWork.length}`);
  for (const item of value.activeWork) console.log(`  ${item.status} ${item.kind} ${item.sourceRef}`);
  console.log(`Missing expected boundaries: ${value.missingExpected.length}`);
  for (const item of value.missingExpected) console.log(`  ${item.subjectId} missing ${item.expectedDerivation}`);
  console.log(`Degraded non-empty fallbacks: ${value.degradedFallbacks.length}`);
  for (const item of value.degradedFallbacks) {
    console.log(`  ${item.band} ${item.subjectKind}/${item.subjectId} via ${item.derivationUsed}`);
  }
  console.log(`Empty view gaps: ${value.emptyGaps.length}`);
  for (const item of value.emptyGaps) console.log(`  ${item.band} ${item.subjectKind}/${item.subjectId}: ${item.reason ?? ""}`);
  if (value.viewSnapshotComparison.differs) {
    console.log("View snapshot differs from current derivation rows. This is expected after post-view work; do not use it as live health.");
  }
}

function printSummaries(value) {
  for (const item of value) {
    const disposition = item.reason ? ` reason=${item.reason}` : "";
    console.log(
      `${item.subjectId} ${item.derivationType} ${item.state} v${item.sourceVersion} chars=${item.contentCharacters ?? 0}${disposition}`,
    );
    if (item.preview) console.log(`  ${item.preview.replaceAll("\n", "\n  ")}`);
  }
}

function printSubject(value) {
  printJson(value);
}

export function run(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const filePath = argv[0];
  const command = argv[1];
  if (!filePath || !command) throw new Error(HELP);
  const { positional, options } = parseOptions(argv.slice(2));
  const { db, filePath: absolute } = openThread(filePath);
  try {
    let result;
    if (command === "summary") {
      result = readSummary(db, absolute);
      options.json ? printJson(result) : printSummary(result);
      return 0;
    }
    if (command === "issues") {
      result = readIssues(db);
      options.json ? printJson(result) : printIssues(result);
      return 0;
    }
    if (command === "summaries") {
      result = readSummaries(db, {
        type: options.type,
        state: options.state,
        limit: options.limit,
        offset: options.offset,
        maxChars: options["max-chars"],
      });
      options.json ? printJson(result) : printSummaries(result);
      return 0;
    }
    if (command === "show") {
      const [subjectKind, subjectId] = positional;
      if (!subjectKind || !subjectId) throw new Error("show requires: turn <tN> or chunk <cN>");
      const subjectOptions = { maxChars: options["max-chars"] };
      if (subjectKind === "turn") result = readTurn(db, subjectId, subjectOptions);
      else if (subjectKind === "chunk") result = readChunk(db, subjectId, subjectOptions);
      else throw new Error(`unknown subject kind: ${subjectKind}`);
      printSubject(result);
      return 0;
    }
    throw new Error(`unknown command: ${command}\n\n${HELP}`);
  } finally {
    db.close();
  }
}

const invokedPath = process.argv[1];
const isMain = invokedPath !== undefined && realpathSync(invokedPath) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
