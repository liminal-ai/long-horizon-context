/**
 * Portable old-child cleanup classification.
 *
 * The old-child port returns this three-way result directly. Classification
 * uses the existing native identity probe plus exact identity comparison —
 * never a collapsed `{ exited, pid }` boolean reconstructed later.
 */

import {
  identitiesEqual,
  type ProbeProcessIdentity,
  type ProcessIdentity,
  type ProcessLivenessResult,
} from "../runtime/process-identity.js";

export type OldChildCleanup =
  | { kind: "terminated"; pid: number }
  | { kind: "surviving_orphan"; pid: number }
  /** Deliberately kept alive as the adopted background tasks' completion host (LIM-149). */
  | { kind: "retained_task_host"; pid: number }
  | { kind: "unknown"; pid?: number; detail: string };

export type OldChildTerminationAttempt =
  | { status: "pty_exited" }
  | { status: "completed_non_exit" }
  | { status: "threw"; detail: string };

export function formatOldChildCleanup(cleanup: OldChildCleanup): string {
  switch (cleanup.kind) {
    case "terminated":
      return `old child pid ${cleanup.pid} terminated`;
    case "surviving_orphan":
      return `old child pid ${cleanup.pid} is a surviving orphan and may still be running`;
    case "retained_task_host":
      return `old child pid ${cleanup.pid} retained as the adopted background tasks' completion host`;
    case "unknown":
      return cleanup.pid === undefined
        ? `old-child cleanup outcome unknown; the old child may still be running (${cleanup.detail})`
        : `old-child cleanup outcome unknown for pid ${cleanup.pid}; the old child may still be running (${cleanup.detail})`;
  }
}

/**
 * Classify a completed termination attempt from identity evidence.
 *
 * - PTY exit, post `not_found`, or a changed identity means terminated.
 * - The same exact retained identity after a completed non-exit is a surviving orphan.
 * - Missing baseline, indeterminate post-probe, thrown termination without
 *   independent absence/change proof, or timeout without identity proof is unknown.
 */
export function classifyOldChildCleanup(input: {
  pid: number;
  baseline: ProcessIdentity | null;
  attempt: OldChildTerminationAttempt;
  post: ProcessLivenessResult | null;
}): OldChildCleanup {
  const { pid, baseline, attempt, post } = input;

  if (attempt.status === "pty_exited") {
    return { kind: "terminated", pid };
  }

  if (post !== null && post.ok === false && post.code === "not_found") {
    return { kind: "terminated", pid };
  }

  if (post !== null && post.ok === true) {
    if (baseline !== null && !identitiesEqual(baseline, post.identity)) {
      return { kind: "terminated", pid };
    }
    if (baseline !== null && identitiesEqual(baseline, post.identity)) {
      if (attempt.status === "completed_non_exit") {
        return { kind: "surviving_orphan", pid };
      }
      return {
        kind: "unknown",
        pid,
        detail:
          attempt.status === "threw"
            ? `termination threw (${attempt.detail}) while the same process identity remained live`
            : "same process identity remained live without a completed non-exit result",
      };
    }
    return {
      kind: "unknown",
      pid,
      detail: "a live process occupies the pid but no exact pre-termination identity was established",
    };
  }

  const probeDetail =
    post === null
      ? "post-termination identity was not observed"
      : `post-termination identity was indeterminate (${post.message})`;

  if (attempt.status === "threw") {
    return {
      kind: "unknown",
      pid,
      detail: `termination threw (${attempt.detail}); ${probeDetail}`,
    };
  }

  return {
    kind: "unknown",
    pid,
    detail: `bounded termination completed without a PTY exit; ${probeDetail}`,
  };
}

export async function observeOldChildCleanup(input: {
  pid: number;
  alreadyExited: boolean;
  probe: ProbeProcessIdentity;
  terminate: () => Promise<boolean>;
  onWarn: (message: string) => void;
}): Promise<OldChildCleanup> {
  const { pid, probe, terminate, onWarn } = input;
  if (input.alreadyExited) {
    return { kind: "terminated", pid };
  }

  let baseline: ProcessIdentity | null = null;
  try {
    const pre = probe(pid);
    if (pre.ok) {
      baseline = pre.identity;
    } else if (pre.code === "not_found") {
      onWarn(`cc-lhc handoff: old-child identity baseline not_found pid=${pid} — cleanup still proceeds`);
    } else {
      onWarn(`cc-lhc handoff: old-child identity baseline unavailable pid=${pid}: ${pre.message}`);
    }
  } catch (cause) {
    onWarn(
      `cc-lhc handoff: old-child identity baseline probe threw pid=${pid}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  let attempt: OldChildTerminationAttempt;
  try {
    const exited = await terminate();
    attempt = exited ? { status: "pty_exited" } : { status: "completed_non_exit" };
  } catch (cause) {
    attempt = {
      status: "threw",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
    onWarn(`cc-lhc handoff: terminating old child pid=${pid} threw: ${attempt.detail}`);
  }

  if (attempt.status === "pty_exited") {
    return { kind: "terminated", pid };
  }

  let post: ProcessLivenessResult | null = null;
  try {
    post = probe(pid);
  } catch (cause) {
    onWarn(
      `cc-lhc handoff: old-child post-termination identity probe threw pid=${pid}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  return classifyOldChildCleanup({ pid, baseline, attempt, post });
}
