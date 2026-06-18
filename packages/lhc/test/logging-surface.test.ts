import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDeterministicInferenceCallbacks,
  initLhc,
  writeLog,
  type InferenceCallbacks,
  type DrainReport,
  type Lhc,
  type LogEntry,
  type LogLevel,
  type MessageEventInput,
} from "../src/index.js";
import { createInferenceCallbacksDouble, openRaw, tempStore, validEvent } from "./fixtures/index.js";

let store: ReturnType<typeof tempStore>;
let sdk: Lhc;

beforeEach(() => {
  store = tempStore();
  sdk = initLhc({ inferenceCallbacks: createDeterministicInferenceCallbacks(), mode: "manual" });
});

afterEach(() => {
  store.cleanup();
});

async function newThread(): Promise<string> {
  const filePath = store.threadPath("logging-test");
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  expect(created.ok).toBe(true);
  return filePath;
}

async function write(filePath: string, entry: LogEntry): Promise<void> {
  const written = await sdk.logging.write({ filePath }, entry);
  expect(written.ok).toBe(true);
}

function manualSdk(inferenceCallbacks: InferenceCallbacks): Lhc {
  return initLhc({
    inferenceCallbacks,
    mode: "manual",
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    lease: { durationMs: 200 },
  });
}

async function send(
  target: Lhc,
  filePath: string,
  batch: readonly MessageEventInput[],
): Promise<void> {
  const result = await target.intakeStream.messageEvents({ filePath }, batch);
  expect(result.ok).toBe(true);
}

async function drain(target: Lhc, filePath: string): Promise<DrainReport> {
  const result = await target.work.drain({ filePath });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("drain failed");
  return result.value;
}

async function sendTurn(target: Lhc, filePath: string): Promise<void> {
  await send(target, filePath, [
    validEvent("user_prompt", { payload: { text: "raw prompt one" } }),
    validEvent("assistant_text", { payload: { text: "answer text" } }),
    validEvent("turn_end"),
  ]);
}

describe("Flow 5: Derivation Logging", () => {
  it("TC-5.1a persists info, warning, and error levels", async () => {
    const filePath = await newThread();

    for (const level of ["info", "warning", "error"] as LogLevel[]) {
      await write(filePath, { level, message: `${level} message` });
    }

    const queried = await sdk.logging.query({ filePath }, {});
    expect(queried.ok).toBe(true);
    if (!queried.ok) return;
    expect(queried.value.map((entry) => entry.level).sort()).toEqual([
      "error",
      "info",
      "warning",
    ]);
  });

  it("TC-5.2a writes internal and external callers through the same store", async () => {
    const filePath = await newThread();
    const db = openRaw(filePath);
    try {
      writeLog(
        {
          db,
          clock: () => new Date("2026-01-01T00:00:00.000Z"),
          threadId: "logging-test",
          onCommit: () => {},
          poke: () => {},
        },
        {
          level: "info",
          message: "internal caller",
          derivationType: "smoothed_prompt",
          subjectId: "m1",
        },
      );
    } finally {
      db.close();
    }

    await write(filePath, {
      level: "warning",
      message: "external caller",
      derivationType: "tool_result_summary",
      subjectId: "m2",
    });

    const queried = await sdk.logging.query({ filePath }, {});
    expect(queried.ok).toBe(true);
    if (!queried.ok) return;
    expect(queried.value.map((entry) => entry.message).sort()).toEqual([
      "external caller",
      "internal caller",
    ]);
  });

  it("TC-5.3a keeps fallback events in the log, not on ready derivations", async () => {
    const filePath = await newThread();
    const double = createInferenceCallbacksDouble();
    double.failKind("prompt_smoothing", 4, { retryable: true, reason: "scripted smoothing failure" });
    const target = manualSdk(double);
    await sendTurn(target, filePath);
    const report = await drain(target, filePath);
    expect(report.ran.map((entry) => [entry.workItemId, entry.disposition])).toEqual([
      ["w-m1-prompt_smoothing-v1", "failed_terminal"],
      ["w-t1-turn_derivation-v1", "done"],
    ]);

    const read = openRaw(filePath);
    try {
      const row = read
        .prepare(`SELECT state, content, reason, gaps, metadata FROM derivation WHERE subject_id = ?`)
        .get("t1") as
        | {
            state: string;
            content: string;
            reason: string | null;
            gaps: string | null;
            metadata: string | null;
          }
        | undefined;
      expect(row).toMatchObject({
        state: "ready",
        reason: null,
        gaps: null,
      });
      expect(row?.content).toContain("raw prompt one");
      expect(row?.metadata).toBeNull();
    } finally {
      read.close();
    }

    const queried = await sdk.logging.query({ filePath }, { derivationType: "smoothed_prompt" });
    expect(queried.ok).toBe(true);
    if (!queried.ok) return;
    expect(queried.value).toHaveLength(1);
    expect(queried.value[0]?.derivationType).toBe("smoothed_prompt");
    expect(queried.value[0]?.subjectId).toBe("m1");
    expect(queried.value[0]?.floorUsed).toBe("raw prompt one");
  });

  it("TC-5.3b keeps failed state and reason on the derivation record", async () => {
    const filePath = await newThread();
    const db = openRaw(filePath);
    try {
      db.prepare(
        `INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, reason)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("message", "m2", "tool_result_summary", "failed", "provider_unavailable");
    } finally {
      db.close();
    }

    await write(filePath, {
      level: "error",
      message: "diagnostic",
      derivationType: "tool_result_summary",
      subjectId: "m2",
      reason: "provider_unavailable",
    });

    const read = openRaw(filePath);
    try {
      const row = read
        .prepare(`SELECT state, reason FROM derivation WHERE subject_id = ?`)
        .get("m2") as { state: string; reason: string } | undefined;
      expect(row).toEqual({ state: "failed", reason: "provider_unavailable" });
    } finally {
      read.close();
    }
  });

  it("TC-5.4a queries by actionable fields", async () => {
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

    const queried = await sdk.logging.query(
      { filePath },
      { level: "warning", derivationType: "smoothed_prompt", reason: "not_ready" },
    );
    expect(queried.ok).toBe(true);
    if (!queried.ok) return;
    expect(queried.value.map((entry) => entry.message)).toEqual(["smoothed fallback"]);
  });

  it("TC-5.5a contains logging write failures", async () => {
    const filePath = await newThread();
    const db = openRaw(filePath);
    try {
      db.exec("BEGIN IMMEDIATE;");
      try {
        db.prepare(
          `INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, content)
           VALUES (?, ?, ?, ?, ?)`,
        ).run("turn", "t1", "turn_rendering", "ready", "turn content");

        expect(() =>
          writeLog(
            {
              db: {
                prepare: () => {
                  throw new Error("log store unavailable");
                },
              } as never,
              clock: () => new Date("2026-01-01T00:00:00.000Z"),
              threadId: "logging-test",
              onCommit: () => {},
              poke: () => {},
            },
            { level: "warning", message: "will be dropped" },
          ),
        ).not.toThrow();

        db.prepare(
          `INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, content)
           VALUES (?, ?, ?, ?, ?)`,
        ).run("turn", "t1", "smooth_turn_compression", "ready", "projection content");
        db.exec("COMMIT;");
      } catch (cause) {
        db.exec("ROLLBACK;");
        throw cause;
      }

      const rows = db
        .prepare(`SELECT derivation_type FROM derivation WHERE subject_id = ? ORDER BY derivation_type`)
        .all("t1") as unknown as Array<{ derivation_type: string }>;
      expect(rows.map((row) => row.derivation_type)).toEqual([
        "smooth_turn_compression",
        "turn_rendering",
      ]);
    } finally {
      db.close();
    }
  });

  it("TC-5.5b keeps log writes outside caller rollbacks in a real store", async () => {
    const filePath = await newThread();
    await write(filePath, {
      level: "info",
      message: "before rollback",
      derivationType: "turn_rendering",
      subjectId: "t-rollback",
      reason: "rollback_probe",
    });

    const db = openRaw(filePath);
    try {
      db.exec("BEGIN IMMEDIATE;");
      db.prepare(
        `INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, content)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("turn", "t-rollback", "turn_rendering", "ready", "rolled back content");
      db.exec("ROLLBACK;");

      const derivationRows = db
        .prepare(`SELECT COUNT(*) AS n FROM derivation WHERE subject_id = ?`)
        .get("t-rollback") as { n: number | bigint };
      expect(Number(derivationRows.n)).toBe(0);
    } finally {
      db.close();
    }

    const queried = await sdk.logging.query({ filePath }, { subjectId: "t-rollback" });
    expect(queried.ok).toBe(true);
    if (!queried.ok) return;
    expect(queried.value.map((entry) => entry.message)).toEqual(["before rollback"]);
  });
});
