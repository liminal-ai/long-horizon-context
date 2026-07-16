// Flow 5: operator (derivation) logging — persistence across levels (TC-5.1a),
// internal + external callers landing in one store (TC-5.2a), the fallback
// event living in the log while the derivation itself reads ready (TC-5.3a),
// and actionable-field filtering (TC-5.4a).
//
// Substrate-only frozen legs (documented n/a):
//   - TC-5.2a's `writeLog(...)` direct-store call and TC-5.5a/TC-5.5b's
//     failure-containment and rollback-isolation legs all exercise the frozen
//     in-process SQLite log store: a throwing `prepare` seam, a
//     `BEGIN IMMEDIATE`/`ROLLBACK` around a raw derivation insert. On Convex,
//     operator logs are written inside the same atomic mutation as the drain
//     completion (there is no separate best-effort log store and no caller
//     rollback that could strand or resurrect a log row), so these mechanisms
//     have no analog. TC-5.2a is reshaped to a real INTERNAL caller (a
//     drain-produced fallback log) plus an external `logging.write`.
//   - The background "logging.write catches up leftover work" leg drives a
//     scheduled background drain, which convex-test cannot advance. The
//     read-only guarantee of `logging.query` is ported.
import { beforeEach, describe, expect, test } from "vitest";
import type { Lhc, LogEntry, MessageEventInput, StoredLogEntry } from "../src/client/index.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

let fixture: ServiceFixture;
let sdk: Lhc;

beforeEach(() => {
  fixture = serviceFixture();
  sdk = fixture.sdk;
});

async function newThread(): Promise<string> {
  return (await fixture.createThread()).filePath;
}

async function write(filePath: string, entry: LogEntry): Promise<void> {
  const written = await sdk.logging.write({ filePath }, entry);
  expect(written.ok).toBe(true);
}

async function query(filePath: string, filter: Record<string, unknown> = {}): Promise<StoredLogEntry[]> {
  const result = await sdk.logging.query({ filePath }, filter);
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
}

async function sendTurn(target: Lhc, filePath: string): Promise<void> {
  const events: MessageEventInput[] = [
    validEvent("user_prompt", { payload: { text: "raw prompt one" } }),
    validEvent("assistant_text", { payload: { text: "answer text" } }),
    validEvent("turn_end"),
  ];
  const result = await target.intakeStream.messageEvents({ filePath }, events);
  expect(result.ok).toBe(true);
}

describe("Flow 5: Derivation Logging", () => {
  test("TC-5.1a persists info, warning, and error levels", async () => {
    const filePath = await newThread();
    for (const level of ["info", "warning", "error"] as const) {
      await write(filePath, { level, message: `${level} message` });
    }

    const queried = await query(filePath);
    expect(queried.map((entry) => entry.level).sort()).toEqual(["error", "info", "warning"]);
  });

  test("TC-5.2a writes internal (drain fallback) and external callers through the same store", async () => {
    // An internal caller: a drain whose smoothing fails floors the prompt and
    // records a "derivation fallback used" operator log through the component's
    // own path.
    const scripted = serviceFixture({ models: { smoothed_prompt: "fail" } });
    const filePath = (await scripted.createThread()).filePath;
    await sendTurn(scripted.sdk, filePath);
    const drained = await scripted.sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);

    // An external caller through the public SDK.
    const externalWrite = await scripted.sdk.logging.write(
      { filePath },
      { level: "warning", message: "external caller", derivationType: "tool_result_summary", subjectId: "m2" },
    );
    expect(externalWrite.ok).toBe(true);

    const result = await scripted.sdk.logging.query({ filePath }, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const messages = result.value.map((entry) => entry.message).sort();
    expect(messages).toEqual(["derivation fallback used", "external caller"]);
    // The internal log carries the derivation coordinates it was raised for.
    const internal = result.value.find((entry) => entry.message === "derivation fallback used");
    expect(internal?.derivationType).toBe("smoothed_prompt");
    expect(internal?.subjectId).toBe("m1");
  });

  test("TC-5.3a keeps fallback events in the log, not on the ready derivation", async () => {
    const scripted = serviceFixture({ models: { smoothed_prompt: "fail" } });
    const filePath = (await scripted.createThread()).filePath;
    await sendTurn(scripted.sdk, filePath);
    const report = await scripted.sdk.work.drain({ filePath });
    expect(report.ok).toBe(true);

    // The turn rendering itself reads ready with the floored prompt in its
    // content and no fallback metadata — the fallback lives only in the log.
    const rendering = await scripted.test.run(async (ctx) => {
      const rows = await ctx.db
        .query("derivations")
        .filter((q) => q.eq(q.field("subject"), "t1"))
        .collect();
      return rows.find((r) => r.deriv === "turn_rendering") ?? null;
    });
    expect(rendering?.state).toBe("ready");
    expect(rendering?.reason).toBeUndefined();
    expect(rendering?.content).toContain("raw prompt one");
    expect(rendering?.metadata).toBeUndefined();

    const queried = await scripted.sdk.logging.query({ filePath }, { derivationType: "smoothed_prompt" });
    expect(queried.ok).toBe(true);
    if (!queried.ok) return;
    expect(queried.value).toHaveLength(1);
    expect(queried.value[0]?.derivationType).toBe("smoothed_prompt");
    expect(queried.value[0]?.subjectId).toBe("m1");
    expect(queried.value[0]?.floorUsed).toBe("raw prompt one");
  });

  test("TC-5.4a queries by actionable fields", async () => {
    const filePath = await newThread();
    await write(filePath, {
      level: "info",
      message: "smoothed ok",
      derivationType: "smoothed_prompt",
      subjectId: "m1",
      reason: "observed",
    });
    await write(filePath, {
      level: "warning",
      message: "tool fallback",
      derivationType: "tool_result_summary",
      subjectId: "m2",
      reason: "not_ready",
    });
    await write(filePath, {
      level: "warning",
      message: "smoothed fallback",
      derivationType: "smoothed_prompt",
      subjectId: "m3",
      reason: "not_ready",
    });

    const queried = await query(filePath, {
      level: "warning",
      derivationType: "smoothed_prompt",
      reason: "not_ready",
    });
    expect(queried.map((entry) => entry.message)).toEqual(["smoothed fallback"]);
  });

  test("logging.query stays read-only over a thread with leftover work", async () => {
    const filePath = await newThread();
    await sendTurn(sdk, filePath);

    const before = await sdk.work.status({ filePath });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.value.queued).toBeGreaterThan(0);

    const queried = await sdk.logging.query({ filePath }, {});
    expect(queried.ok).toBe(true);

    const after = await sdk.work.status({ filePath });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    // The read did not advance or drain the queue.
    expect(after.value).toEqual(before.value);
  });
});
