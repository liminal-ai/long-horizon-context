#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { LIVE } from "./drives.mjs";

const RUNS = 3;
const BAR = 0.2;
const CAP_MS = 600_000;

const { values } = parseArgs({
  options: {
    "base-sha": { type: "string" },
    "head-sha": { type: "string" },
    base: { type: "string", multiple: true, default: [] },
    head: { type: "string", multiple: true, default: [] },
    "report-only": { type: "boolean", default: false },
  },
});
if (!values["base-sha"] || !values["head-sha"] || values.base.length !== RUNS || values.head.length !== RUNS) {
  console.log(`usage: perf-compare.mjs --base-sha <sha> --head-sha <sha> --base <summary.json> x${RUNS} --head <summary.json> x${RUNS} [--report-only], each side's files in sample order`);
  console.log("VERIFY-CLAUDE-LHC perf-compare: FAIL usage");
  process.exit(2);
}

const problems = [];
const load = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8")).drives ?? {};
  } catch (error) {
    problems.push(`${file} is unreadable: ${error.message}`);
    return {};
  }
};
const sides = { base: values.base.map((file) => ({ file, drives: load(file) })), head: values.head.map((file) => ({ file, drives: load(file) })) };
const seededNames = (drives) => Object.keys(drives).filter((name) => !LIVE.includes(name));
const baseline = [...new Set(sides.base.flatMap((run) => seededNames(run.drives)))];

console.log(`base ${values["base-sha"]}`);
console.log(`head ${values["head-sha"]}`);
console.log(`baseline seeded drives (${baseline.length}): ${baseline.join(", ")}`);
const sums = { base: [], head: [] };
const totals = [];
for (const side of ["base", "head"]) {
  sides[side].forEach((run, i) => {
    for (const name of baseline) {
      const drive = run.drives[name];
      if (!drive) problems.push(`${side} sample ${i + 1} (${run.file}) has no ${name}`);
      else if (drive.status !== "pass") problems.push(`${side} sample ${i + 1} (${run.file}) ${name} is ${drive.status}`);
    }
    const shared = baseline.reduce((sum, name) => sum + (run.drives[name]?.ms ?? 0), 0);
    const all = seededNames(run.drives).reduce((sum, name) => sum + run.drives[name].ms, 0);
    sums[side].push(shared);
    if (side === "head") totals.push(all);
    console.log(`${side} sample ${i + 1}: baseline drives ${shared} ms, all seeded drives ${all} ms (${run.file})`);
  });
}
console.log("not checked from the files: that the runs were warm and interleaved; state both in the verdict");

if (problems.length > 0) {
  for (const problem of problems) console.log(`invalid: ${problem}`);
  console.log(`VERIFY-CLAUDE-LHC perf-compare: FAIL ${problems.length} invalid sample(s)`);
  process.exit(1);
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const baseMedian = median(sums.base);
const headMedian = median(sums.head);
const increase = headMedian / baseMedian - 1;
console.log(`median over baseline drives: base ${baseMedian} ms, head ${headMedian} ms, change ${(increase * 100).toFixed(1)}%`);
const findings = [];
if (increase > BAR) findings.push(`head median is ${(increase * 100).toFixed(1)}% above base, past the 20% bar`);
totals.forEach((ms, i) => {
  if (ms > CAP_MS) findings.push(`head sample ${i + 1} seeded drives took ${ms} ms, past the 600000 ms cap`);
});

if (values["report-only"]) {
  for (const finding of findings) console.log(`explain: ${finding}`);
  console.log(`VERIFY-CLAUDE-LHC perf-compare: REPORT ${findings.length === 0 ? "within the 20% bar and the cap" : `${findings.length} increase(s) to explain`}`);
  process.exit(0);
}
if (findings.length > 0) {
  console.log(`VERIFY-CLAUDE-LHC perf-compare: FAIL ${findings.join("; ")}`);
  process.exit(1);
}
console.log("VERIFY-CLAUDE-LHC perf-compare: PASS");
