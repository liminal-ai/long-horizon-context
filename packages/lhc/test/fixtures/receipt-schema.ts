// The shared SweepReceipt schema (TC-3.3, AC-3.5/AC-3.7): one structural
// validator both the SDK leg (view-sweep.test.ts, Story 3) and the spawned
// CLI parity leg (cli-process-view.test.ts, Story 5) assert against — "same
// receipt shape" is proven by both targets passing the same checker, not by
// two hand-kept assertion lists drifting apart.
import type { SweepReceipt } from "../../src/index.js";

function fail(path: string, expected: string, actual: unknown): never {
  throw new Error(`SweepReceipt schema violation at ${path}: expected ${expected}, got ${JSON.stringify(actual)}`);
}

function assertCount(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(path, "a non-negative integer", value);
  }
}

function assertSubjectReasonList(value: unknown, path: string): void {
  if (!Array.isArray(value)) fail(path, "an array", value);
  value.forEach((item, i) => {
    if (typeof item !== "object" || item === null) fail(`${path}[${i}]`, "an object", item);
    const entry = item as Record<string, unknown>;
    if (typeof entry.subjectId !== "string" || entry.subjectId === "") {
      fail(`${path}[${i}].subjectId`, "a non-empty string", entry.subjectId);
    }
    if (typeof entry.reason !== "string" || entry.reason === "") {
      fail(`${path}[${i}].reason`, "a non-empty string", entry.reason);
    }
  });
}

export function assertSweepReceiptShape(value: unknown): asserts value is SweepReceipt {
  if (typeof value !== "object" || value === null) fail("receipt", "an object", value);
  const receipt = value as Record<string, unknown>;
  if (!Array.isArray(receipt.owners)) fail("receipt.owners", "an array", receipt.owners);
  receipt.owners.forEach((line, i) => {
    const path = `owners[${i}]`;
    if (typeof line !== "object" || line === null) fail(path, "an object", line);
    const entry = line as Record<string, unknown>;
    if (entry.owner !== "messages" && entry.owner !== "turns") {
      fail(`${path}.owner`, '"messages" | "turns"', entry.owner);
    }
    if (typeof entry.kind !== "string" || entry.kind === "") {
      fail(`${path}.kind`, "a non-empty string", entry.kind);
    }
    assertCount(entry.ready, `${path}.ready`);
    assertCount(entry.inFlight, `${path}.inFlight`);
    if (!Array.isArray(entry.requeued) || entry.requeued.some((id) => typeof id !== "string" || id === "")) {
      fail(`${path}.requeued`, "an array of non-empty subject-id strings", entry.requeued);
    }
    assertSubjectReasonList(entry.blocked, `${path}.blocked`);
    assertSubjectReasonList(entry.permanentFailed, `${path}.permanentFailed`);
  });
}
