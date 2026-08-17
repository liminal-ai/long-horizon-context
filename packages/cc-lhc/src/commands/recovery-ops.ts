/**
 * LIM-80 Slice 2: command-layer recovery ports and executors.
 *
 * These close the cross-database crash gap between an installed LHC view (in
 * the thread file) and the durable attempt stage (in cc-lhc.sqlite), and the
 * gap between a reserved Claude session id and the rebuilt rollout file. They
 * read the LHC view and (re)materialize a rebuilt rollout WITHOUT running
 * previewCompact / compact / prune — the installed view is authoritative.
 *
 * Recovery inputs after a restart come only from durable store artifacts plus
 * fresh filesystem / SDK observations — never from pre-crash process memory.
 *
 * Live boundary: Slice 2 wires only the command operation (runContextMutation
 * calls these ports around the compact/write). The CONCRETE store-backed
 * RecoveryPort, the run.ts scheduled-replay execution, child termination/spawn,
 * replacement/lineage/descriptor advancement, the handoff itself, and startup
 * recovery remain Slice 3. Executors here only return verified artifacts / a
 * normal HandoffRequest for that later slice to hand off.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Lhc, SessionThreadView, StoredView, ThreadRef } from "lhc";

import { type CurrentStoredViewObservation, storedViewFingerprint } from "../governor/recovery.js";
import { encodeProjectPath } from "../rollout/discover.js";
import { appendSessionsIndexEntry, type RolloutWriteDeps, rolloutPathForSession } from "../rollout/sessions-index.js";
import { type WriteRebuiltRolloutResult, writeRebuiltRollout } from "../rollout/write-rebuilt.js";
import type { HandoffRequest } from "./context-mutation.js";
import type { LhcCommandRuntime } from "./dispatch.js";
import { threadIdFromRef } from "./rebuild-receipt.js";

/**
 * Narrow, optional recovery boundary a runtime slice supplies. Absent for
 * ordinary manual compact/prune — those never touch recovery. Every method is
 * a durable write onto the attempt; none carries process lifecycle.
 */
export interface RecoveryPort {
  /** Pre-mutation view fingerprint, persisted BEFORE compact. */
  recordBaseline(preMutationViewFingerprint: string): void;
  /**
   * Installed-view identity, persisted immediately AFTER the SDK compact and
   * BEFORE the post-compact input fence. If this write is lost to a crash, the
   * operation_claimed baseline comparison still recovers the install.
   */
  recordViewInstalled(args: { viewId: string; installedViewFingerprint: string }): void;
  /**
   * Reserve the rebuilt Claude session id + expected rollout path and persist
   * them (with the durable receipt) BEFORE any rollout write, so a crash
   * before/after fsync is discoverable by that exact id. Idempotent per
   * attempt.
   */
  reserveRebuiltSession(durableReceipt: string): { sessionId: string; rolloutPath: string };
  /** Verification identities, persisted AFTER the write is fully verified. */
  recordRolloutWritten(verification: RolloutVerificationArtifacts): void;
}

export interface RolloutVerificationArtifacts {
  rebuiltSessionId: string;
  rebuiltRolloutPath: string;
  /** sha256 of the WHOLE file (prefix + trailing runtime-note receipt). */
  rolloutFullSha256: string;
  rolloutPrefixSha256: string;
  rolloutPrefixLineCount: number;
  rolloutPrefixByteLength: number;
  /** Whole-file line count (prefix + receipt). */
  rolloutLineCount: number;
  /** Whole-file byte length. */
  rolloutByteLength: number;
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function defaultProjectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

// ── stored-view observation ──────────────────────────────────────────

/**
 * Read the current LHC stored view. `describe` null → `none`; a read error →
 * `unreadable` (transient, never a contradiction).
 */
export async function observeCurrentStoredView(sdk: Lhc, threadRef: ThreadRef): Promise<CurrentStoredViewObservation> {
  let stored: StoredView | null;
  try {
    const result = await sdk.threadView.describe(threadRef);
    if (!result.ok) return { kind: "unreadable", reason: result.error.reason };
    stored = result.value;
  } catch (cause) {
    return { kind: "unreadable", reason: detail(cause) };
  }
  if (stored === null) return { kind: "none" };
  return { kind: "present", viewId: stored.viewId, fingerprint: storedViewFingerprint(stored) };
}

/** Pre-mutation baseline fingerprint (or NO_STORED_VIEW when absent). */
export async function captureViewBaselineFingerprint(sdk: Lhc, threadRef: ThreadRef): Promise<string> {
  const observed = await observeCurrentStoredView(sdk, threadRef);
  if (observed.kind === "unreadable") throw new Error(`cannot read stored view baseline: ${observed.reason}`);
  return observed.kind === "none" ? storedViewFingerprint(null) : observed.fingerprint;
}

async function fetchServedView(sdk: Lhc, threadRef: ThreadRef): Promise<SessionThreadView> {
  const view = await sdk.threadView.getSessionThreadView(threadRef);
  if (!view.ok) throw new Error(`served view read failed: ${view.error.reason}`);
  return view.value;
}

// ── whole-file structural inspection ─────────────────────────────────

export type ReadBytesFn = (path: string) => Promise<Buffer>;

type BytesResult = { kind: "bytes"; buf: Buffer } | { kind: "absent" } | { kind: "unreadable"; reason: string };

/**
 * Distinguish absent (ENOENT) from unreadable (permission / I/O / read race).
 * `read` is the authoritative op — never `statRolloutFile`, which collapses
 * all stat errors to null. An unreadable present file must never be
 * overwritten; only a proven-absent file may be rematerialized.
 */
async function readRolloutBytes(path: string, readFn?: ReadBytesFn): Promise<BytesResult> {
  const read = readFn ?? ((p: string) => readFile(p));
  try {
    return { kind: "bytes", buf: await read(path) };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", reason: detail(cause) };
  }
}

export type RolloutInspection =
  | { kind: "ok"; verification: RolloutVerificationArtifacts; firstPrompt: string; messageCount: number }
  | { kind: "invalid"; reason: string };

interface ParsedRolloutLine {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  sessionId?: unknown;
  session_id?: unknown;
  message?: { role?: unknown; content?: unknown } | undefined;
}

function firstUserPromptFromParsed(parsed: readonly ParsedRolloutLine[]): string {
  for (const line of parsed) {
    const content = line.message?.content;
    if (typeof content === "string" && !content.startsWith("[runtime note] ")) return content;
  }
  return "";
}

/**
 * Verify a rebuilt rollout's whole-file structure against the reserved session
 * id and durable receipt, and derive its verification identities. Every line
 * is parsed; every sessionId / session_id must equal the reserved id; the
 * uuid/parent chain must be intact with no duplicate uuids; the trailing line
 * must be exactly `[runtime note] <durableReceipt>`; the prefix is everything
 * before that trailing receipt. A same-length trailing-line mutation changes
 * the receipt text (fails here) and the whole-file digest (fails cross-check).
 */
export function inspectRolloutBytes(
  buf: Buffer,
  expect: { reservedSessionId: string; rebuiltRolloutPath: string; durableReceipt: string },
): RolloutInspection {
  const invalid = (reason: string): RolloutInspection => ({ kind: "invalid", reason });
  const text = buf.toString("utf8");
  if (text.length === 0) return invalid("reserved rollout is empty");
  const rawLines = text.split("\n");
  if (rawLines[rawLines.length - 1] === "") rawLines.pop();
  if (rawLines.length === 0) return invalid("reserved rollout has no lines");

  const parsed: ParsedRolloutLine[] = [];
  for (const [i, raw] of rawLines.entries()) {
    try {
      parsed.push(JSON.parse(raw) as ParsedRolloutLine);
    } catch {
      return invalid(`line ${i} is not valid JSON`);
    }
  }

  const seen = new Set<string>();
  for (const [i, line] of parsed.entries()) {
    if (line.type !== "user" && line.type !== "assistant") {
      return invalid(`line ${i} has unsupported type ${String(line.type)}`);
    }
    if (line.message?.role !== line.type) {
      return invalid(`line ${i} message role ${String(line.message?.role)} does not match type ${line.type}`);
    }
    if (line.sessionId !== expect.reservedSessionId) {
      return invalid(
        `line ${i} sessionId ${String(line.sessionId)} does not match reserved ${expect.reservedSessionId}`,
      );
    }
    if (line.session_id !== undefined && line.session_id !== expect.reservedSessionId) {
      return invalid(
        `line ${i} session_id ${String(line.session_id)} does not match reserved ${expect.reservedSessionId}`,
      );
    }
    if (typeof line.uuid !== "string" || line.uuid === "") return invalid(`line ${i} has no uuid`);
    if (seen.has(line.uuid)) return invalid(`duplicate uuid ${line.uuid} at line ${i}`);
    seen.add(line.uuid);
    const expectedParent = i === 0 ? null : parsed[i - 1]!.uuid;
    const parent = line.parentUuid ?? null;
    if (parent !== expectedParent) return invalid(`line ${i} parentUuid chain is broken`);
  }

  const last = parsed[parsed.length - 1]!;
  const lastContent = last.message?.content;
  const expectedNote = `[runtime note] ${expect.durableReceipt}`;
  if (last.type !== "user" || last.message?.role !== "user" || lastContent !== expectedNote) {
    return invalid("trailing runtime-note does not match the durable receipt");
  }

  const prefixLineCount = parsed.length - 1;
  const prefixSerialized = prefixLineCount === 0 ? "" : `${rawLines.slice(0, prefixLineCount).join("\n")}\n`;
  const prefixBuf = Buffer.from(prefixSerialized, "utf8");
  return {
    kind: "ok",
    firstPrompt: firstUserPromptFromParsed(parsed),
    messageCount: parsed.length,
    verification: {
      rebuiltSessionId: expect.reservedSessionId,
      rebuiltRolloutPath: expect.rebuiltRolloutPath,
      rolloutFullSha256: sha256(buf),
      rolloutPrefixSha256: sha256(prefixBuf),
      rolloutPrefixLineCount: prefixLineCount,
      rolloutPrefixByteLength: prefixBuf.byteLength,
      rolloutLineCount: parsed.length,
      rolloutByteLength: buf.byteLength,
    },
  };
}

function verificationsEqual(a: RolloutVerificationArtifacts, b: RolloutVerificationArtifacts): boolean {
  return (
    a.rebuiltSessionId === b.rebuiltSessionId &&
    a.rebuiltRolloutPath === b.rebuiltRolloutPath &&
    a.rolloutFullSha256 === b.rolloutFullSha256 &&
    a.rolloutPrefixSha256 === b.rolloutPrefixSha256 &&
    a.rolloutPrefixLineCount === b.rolloutPrefixLineCount &&
    a.rolloutPrefixByteLength === b.rolloutPrefixByteLength &&
    a.rolloutLineCount === b.rolloutLineCount &&
    a.rolloutByteLength === b.rolloutByteLength
  );
}

// ── HandoffRequest assembly ──────────────────────────────────────────

function handoffFromVerification(
  ctx: {
    runtime: LhcCommandRuntime;
    durableReceiptText: string;
    operation: HandoffRequest["operation"];
    metrics?: HandoffRequest["metrics"];
  },
  verification: RolloutVerificationArtifacts,
): HandoffRequest {
  const rebuilt: WriteRebuiltRolloutResult = {
    sessionId: verification.rebuiltSessionId,
    rolloutPath: verification.rebuiltRolloutPath,
    lineCount: verification.rolloutLineCount,
    expectedReintakeLines: verification.rolloutLineCount,
    replayedPrefixLines: verification.rolloutPrefixLineCount,
    prefixBoundary: {
      kind: "verified",
      lineCount: verification.rolloutPrefixLineCount,
      byteLength: verification.rolloutPrefixByteLength,
      sha256: verification.rolloutPrefixSha256,
    },
    totalByteLength: verification.rolloutByteLength,
  };
  return {
    operation: ctx.operation,
    oldSessionId: ctx.runtime.sourceSessionId ?? "unknown",
    threadId: threadIdFromRef(ctx.runtime.threadRef as ThreadRef),
    rebuilt,
    receiptLines: [],
    durableReceipt: ctx.durableReceiptText,
    metrics: ctx.metrics ?? { origin: ctx.operation === "auto_compact" ? "auto" : "manual" },
  };
}

// ── (6a) materialize from the installed view ─────────────────────────

export interface MaterializeFromInstalledViewInput {
  runtime: LhcCommandRuntime;
  reservedSessionId: string;
  /** The durably reserved rollout path; the computed path must equal it. */
  reservedRolloutPath: string;
  /** Fingerprint the installed view must show immediately before AND after read. */
  expectedInstalledFingerprint: string;
  durableReceiptText: string;
  operation: HandoffRequest["operation"];
  metrics?: HandoffRequest["metrics"];
  projectsRoot?: string;
  writeFn?: typeof writeRebuiltRollout;
  readSourceFn?: (path: string) => Promise<string>;
  readBytesFn?: ReadBytesFn;
}

export type MaterializeOutcome =
  | {
      kind: "materialized";
      rebuilt: WriteRebuiltRolloutResult;
      verification: RolloutVerificationArtifacts;
      handoff: HandoffRequest;
    }
  /** The installed view drifted from the expected fingerprint: refuse, do not write. */
  | { kind: "drift"; reason: string }
  /** The stored view could not be read now: retry, do not write. */
  | { kind: "unreadable"; reason: string }
  /** The reserved path disagrees with the computed path: fail closed. */
  | { kind: "invalid"; reason: string };

/**
 * (6a) Materialize a rebuilt rollout from the CURRENTLY INSTALLED LHC view.
 * Never calls previewCompact / compact / prune. Requires the expected view
 * fingerprint both immediately before and immediately after the served-view
 * read, so it never silently materializes whatever view happens to be current.
 */
export async function materializeRolloutFromInstalledView(
  input: MaterializeFromInstalledViewInput,
): Promise<MaterializeOutcome> {
  const { runtime, reservedSessionId, expectedInstalledFingerprint } = input;
  const sdk = runtime.sdk as Lhc;
  const threadRef = runtime.threadRef as ThreadRef;
  const projectsRoot = input.projectsRoot ?? defaultProjectsRoot();

  const computedPath = rolloutPathForSession(projectsRoot, runtime.cwd, reservedSessionId);
  if (computedPath !== input.reservedRolloutPath) {
    return {
      kind: "invalid",
      reason: `computed rollout path ${computedPath} does not equal reserved ${input.reservedRolloutPath}`,
    };
  }

  const requireExpected = (o: CurrentStoredViewObservation, when: string): { ok: true } | MaterializeOutcome => {
    if (o.kind === "unreadable") return { kind: "unreadable", reason: `stored view unreadable ${when}: ${o.reason}` };
    if (o.kind === "none")
      return { kind: "drift", reason: `stored view absent ${when}; expected ${expectedInstalledFingerprint}` };
    if (o.fingerprint !== expectedInstalledFingerprint) {
      return { kind: "drift", reason: `stored view ${o.viewId} drifted ${when} from expected fingerprint` };
    }
    return { ok: true };
  };

  const before = requireExpected(await observeCurrentStoredView(sdk, threadRef), "before read");
  if (!("ok" in before)) return before;
  const view = await fetchServedView(sdk, threadRef);
  const after = requireExpected(await observeCurrentStoredView(sdk, threadRef), "after read");
  if (!("ok" in after)) return after;

  const write = input.writeFn ?? writeRebuiltRollout;
  const rebuilt = await write({
    view,
    cwd: runtime.cwd,
    newSessionId: reservedSessionId,
    projectsRoot,
    ...(runtime.sourceRolloutPath === undefined ? {} : { sourceRolloutPath: runtime.sourceRolloutPath }),
    ...(input.readSourceFn === undefined ? {} : { readSourceFn: input.readSourceFn }),
    receipt: { text: input.durableReceiptText },
  });

  // Inspect our own output so the recorded verification is exactly what a
  // recovery inspection would compute (full digest included).
  const bytes = await readRolloutBytes(rebuilt.rolloutPath, input.readBytesFn);
  if (bytes.kind !== "bytes") {
    return { kind: "unreadable", reason: `wrote rollout but could not read it back: ${bytes.kind}` };
  }
  const inspected = inspectRolloutBytes(bytes.buf, {
    reservedSessionId,
    rebuiltRolloutPath: rebuilt.rolloutPath,
    durableReceipt: input.durableReceiptText,
  });
  if (inspected.kind !== "ok") {
    return { kind: "invalid", reason: `freshly written rollout failed structural inspection: ${inspected.reason}` };
  }
  return {
    kind: "materialized",
    rebuilt,
    verification: inspected.verification,
    handoff: handoffFromVerification(
      {
        runtime,
        durableReceiptText: input.durableReceiptText,
        operation: input.operation,
        ...(input.metrics ? { metrics: input.metrics } : {}),
      },
      inspected.verification,
    ),
  };
}

// ── (6b/6c) verify-reuse and recover the reserved rollout ────────────

export interface RecoverReservedRolloutInput {
  runtime: LhcCommandRuntime;
  /** Durable reservation from the attempt. */
  reservedSessionId: string;
  reservedRolloutPath: string;
  /** Durable receipt persisted at reserve time; the trailing note must match it. */
  durableReceiptText: string;
  /** Expected installed-view fingerprint for a rematerialize. */
  expectedInstalledFingerprint: string;
  operation: HandoffRequest["operation"];
  metrics?: HandoffRequest["metrics"];
  projectsRoot?: string;
  /** Full verification persisted at rollout_written; absent on a pre-record crash. */
  recorded?: RolloutVerificationArtifacts;
  readBytesFn?: ReadBytesFn;
  writeFn?: typeof writeRebuiltRollout;
  /** sessions-index write deps (tests); index repair uses the idempotent append path. */
  indexDeps?: RolloutWriteDeps;
  readSourceFn?: (path: string) => Promise<string>;
}

export type RecoverReservedRolloutResult =
  | { kind: "reused"; handoff: HandoffRequest; verification: RolloutVerificationArtifacts; indexRepaired: boolean }
  | {
      kind: "rematerialized";
      rebuilt: WriteRebuiltRolloutResult;
      verification: RolloutVerificationArtifacts;
      handoff: HandoffRequest;
    }
  /** Transient: unreadable file / unreadable-or-drifted view. Do not overwrite. */
  | { kind: "retry"; reason: string }
  /** Structural contradiction or recorded-verification mismatch: fail closed. */
  | { kind: "invalid"; reason: string };

type IndexRepairResult = { kind: "ok" } | { kind: "conflict"; reason: string } | { kind: "transient"; reason: string };

/**
 * Ensure the sessions-index metadata for a recovered rollout. Idempotent
 * append refreshes in place when present and appends exactly one entry after an
 * fsync-before-index crash. A path-repoint / correlation conflict is a hard
 * failure (→ conflict); any other index I/O is transient (→ transient). Never
 * throws — the caller decides invalid vs retry.
 */
async function ensureSessionsIndex(
  input: RecoverReservedRolloutInput,
  projectsRoot: string,
  inspection: Extract<RolloutInspection, { kind: "ok" }>,
): Promise<IndexRepairResult> {
  const projectDir = join(projectsRoot, encodeProjectPath(input.runtime.cwd));
  try {
    await appendSessionsIndexEntry(
      {
        projectDir,
        sessionId: input.reservedSessionId,
        sessionFilePath: input.reservedRolloutPath,
        firstPrompt: inspection.firstPrompt,
        messageCount: inspection.messageCount,
        projectPath: input.runtime.cwd,
      },
      input.indexDeps ?? {},
    );
    return { kind: "ok" };
  } catch (cause) {
    const reason = detail(cause);
    // Correlation conflict (same session id already listed at a different path)
    // is fail-closed; an unreadable/corrupt index (SESSIONS_INDEX_UNREADABLE_MESSAGE)
    // or any other index I/O is transient.
    if (reason.includes("refusing to repoint")) return { kind: "conflict", reason };
    return { kind: "transient", reason };
  }
}

/**
 * (6b + 6c) Recover the rollout stage from durable state alone:
 *  - reserved file present and structurally valid → verify (cross-check any
 *    recorded verification), repair the sessions-index, reuse it;
 *  - reserved file absent (ENOENT) → rematerialize to the same reserved id;
 *  - reserved file unreadable, or the view is unreadable/drifted → retry (never
 *    overwrite a present-or-indeterminate file);
 *  - structural contradiction / recorded mismatch → fail closed.
 */
export async function recoverReservedRollout(
  input: RecoverReservedRolloutInput,
): Promise<RecoverReservedRolloutResult> {
  const projectsRoot = input.projectsRoot ?? defaultProjectsRoot();
  const computedPath = rolloutPathForSession(projectsRoot, input.runtime.cwd, input.reservedSessionId);
  if (computedPath !== input.reservedRolloutPath) {
    return {
      kind: "invalid",
      reason: `computed rollout path ${computedPath} does not equal reserved ${input.reservedRolloutPath}`,
    };
  }

  const bytes = await readRolloutBytes(input.reservedRolloutPath, input.readBytesFn);
  if (bytes.kind === "unreadable") {
    return {
      kind: "retry",
      reason: `reserved rollout unreadable (present or indeterminate); not overwriting: ${bytes.reason}`,
    };
  }
  if (bytes.kind === "absent") {
    const materialized = await materializeRolloutFromInstalledView({
      runtime: input.runtime,
      reservedSessionId: input.reservedSessionId,
      reservedRolloutPath: input.reservedRolloutPath,
      expectedInstalledFingerprint: input.expectedInstalledFingerprint,
      durableReceiptText: input.durableReceiptText,
      operation: input.operation,
      projectsRoot,
      ...(input.metrics ? { metrics: input.metrics } : {}),
      ...(input.writeFn ? { writeFn: input.writeFn } : {}),
      ...(input.readBytesFn ? { readBytesFn: input.readBytesFn } : {}),
      ...(input.readSourceFn ? { readSourceFn: input.readSourceFn } : {}),
    });
    if (materialized.kind === "materialized") {
      return {
        kind: "rematerialized",
        rebuilt: materialized.rebuilt,
        verification: materialized.verification,
        handoff: materialized.handoff,
      };
    }
    if (materialized.kind === "invalid") return { kind: "invalid", reason: materialized.reason };
    return { kind: "retry", reason: materialized.reason };
  }

  const inspected = inspectRolloutBytes(bytes.buf, {
    reservedSessionId: input.reservedSessionId,
    rebuiltRolloutPath: input.reservedRolloutPath,
    durableReceipt: input.durableReceiptText,
  });
  if (inspected.kind !== "ok") return { kind: "invalid", reason: inspected.reason };

  if (input.recorded !== undefined && !verificationsEqual(input.recorded, inspected.verification)) {
    return {
      kind: "invalid",
      reason: "reserved rollout does not match the recorded verification (whole-file/prefix digest, counts, or bytes)",
    };
  }

  // Ensure sessions-index metadata BEFORE reporting a verified handoff: a
  // correlation conflict fails closed, transient index I/O retries, and the
  // reused handoff is only returned once the index is ensured.
  const indexResult = await ensureSessionsIndex(input, projectsRoot, inspected);
  if (indexResult.kind === "conflict") return { kind: "invalid", reason: indexResult.reason };
  if (indexResult.kind === "transient") {
    return { kind: "retry", reason: `reserved rollout valid but sessions-index not ensured: ${indexResult.reason}` };
  }
  return {
    kind: "reused",
    handoff: handoffFromVerification(
      {
        runtime: input.runtime,
        durableReceiptText: input.durableReceiptText,
        operation: input.operation,
        ...(input.metrics ? { metrics: input.metrics } : {}),
      },
      inspected.verification,
    ),
    verification: inspected.verification,
    indexRepaired: true,
  };
}
