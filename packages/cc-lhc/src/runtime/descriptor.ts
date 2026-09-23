/**
 * Per-wrapper runtime descriptor — sole source of thread/archive binding for
 * model-callable retrieval. Path is inherited by Claude/Bash via
 * CC_LHC_RUNTIME_DESCRIPTOR.
 *
 * Lifecycle transitions (enforced):
 *   opening → ready
 *   opening|ready → degraded
 *   opening|ready|degraded → closed
 *   ready → ready only with identical binding (idempotent republish)
 *   degraded→ready and closed→ready FORBIDDEN
 *
 * Revocation is a checked state transition: prove non-ready publication or
 * verified absence. Never report success while a ready file remains loadable.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { ccLhcHome } from "../intake/paths.js";
import { probeProcessIdentityNative } from "./native-identity.js";
import {
  identitiesEqual,
  type ProbeProcessIdentity,
  type ProcessIdentity,
  ProcessIdentityUnavailableError,
  parseStoredProcessIdentity,
  processIdentityJson,
} from "./process-identity.js";

export const RUNTIME_DESCRIPTOR_ENV = "CC_LHC_RUNTIME_DESCRIPTOR";
export const DESCRIPTOR_VERSION = 1 as const;

export type DescriptorState = "opening" | "ready" | "degraded" | "closed";

export interface RuntimeDescriptorV1 {
  version: typeof DESCRIPTOR_VERSION;
  state: DescriptorState;
  incarnation: string;
  wrapperPid: number;
  wrapperStartedAtMs: number;
  processIdentity: ProcessIdentity;
  updatedAt: string;
  threadId?: string;
  registryPath?: string;
  sessionId?: string;
  rolloutPath?: string;
  degradeReason?: string;
  /** Tokenizer family the wrapper session is using; retrieval inits LHC with it. */
  tokenFamily?: string;
}

export interface DescriptorIo {
  writeFile: (path: string, data: string, mode: number) => void;
  readFile: (path: string) => string;
  rename: (from: string, to: string) => void;
  /** Must throw on failure — callers verify outcomes. */
  unlink: (path: string) => void;
  exists: (path: string) => boolean;
  mkdir: (path: string) => void;
  chmod: (path: string, mode: number) => void;
  /**
   * Exact liveness probe. not_found is kernel-proven dead; indeterminate
   * must fail closed (refuse, never treat as stale).
   */
  readProcessIdentity: ProbeProcessIdentity;
  nowMs: () => number;
  randomId: () => string;
  pid: number;
}

export function defaultDescriptorIo(): DescriptorIo {
  return {
    writeFile: (path, data, mode) => {
      writeFileSync(path, data, { encoding: "utf8", mode });
    },
    readFile: (path) => readFileSync(path, "utf8"),
    rename: renameSync,
    unlink: (path) => {
      unlinkSync(path);
    },
    exists: existsSync,
    mkdir: (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
    chmod: chmodSync,
    readProcessIdentity: probeProcessIdentityNative,
    nowMs: () => Date.now(),
    randomId: () => randomUUID(),
    pid: process.pid,
  };
}

export function runtimeDir(home: string = ccLhcHome()): string {
  return join(home, "runtime");
}

export function newDescriptorPath(home: string = ccLhcHome(), io: DescriptorIo = defaultDescriptorIo()): string {
  io.mkdir(runtimeDir(home));
  return join(runtimeDir(home), `${io.randomId()}.json`);
}

// Platform contract for descriptor confidentiality: on POSIX the 0600 mode
// (and the runtime dir's 0700) is the enforcement. Windows has no POSIX mode
// bits — Node maps mode to the read-only attribute only, so stat reports
// 0666-style modes there. On Windows the enforcement is the cc-lhc home
// location policy: ccLhcHome (src/intake/paths.ts) fails closed when
// CC_LHC_HOME resolves outside the user profile, so the descriptor always
// lives under the profile and inherits its default user-scoped ACLs. No
// bespoke DACL is installed, inspected, or claimed.
export function publishAtomic(path: string, body: string, io: DescriptorIo = defaultDescriptorIo()): void {
  const dir = dirname(path);
  io.mkdir(dir);
  const tmp = join(dir, `.${io.randomId()}.tmp`);
  try {
    io.writeFile(tmp, body, 0o600);
    try {
      io.chmod(tmp, 0o600);
    } catch {
      // mode may already be 0600
    }
    io.rename(tmp, path);
    try {
      io.chmod(path, 0o600);
    } catch {
      // best effort mode
    }
  } catch (cause) {
    try {
      if (io.exists(tmp)) io.unlink(tmp);
    } catch {
      // temp cleanup best effort
    }
    throw cause;
  }
}

function serialize(desc: RuntimeDescriptorV1): string {
  const body = {
    version: desc.version,
    state: desc.state,
    incarnation: desc.incarnation,
    wrapperPid: desc.wrapperPid,
    wrapperStartedAtMs: desc.wrapperStartedAtMs,
    processIdentity: processIdentityJson(desc.processIdentity),
    updatedAt: desc.updatedAt,
    ...(desc.threadId !== undefined ? { threadId: desc.threadId } : {}),
    ...(desc.registryPath !== undefined ? { registryPath: desc.registryPath } : {}),
    ...(desc.sessionId !== undefined ? { sessionId: desc.sessionId } : {}),
    ...(desc.rolloutPath !== undefined ? { rolloutPath: desc.rolloutPath } : {}),
    ...(desc.degradeReason !== undefined ? { degradeReason: desc.degradeReason } : {}),
    ...(desc.tokenFamily !== undefined ? { tokenFamily: desc.tokenFamily } : {}),
  };
  return JSON.stringify(body, null, 2) + "\n";
}

function bindingsEqual(
  a: RuntimeDescriptorV1,
  b: {
    threadId: string;
    registryPath: string;
    sessionId: string;
    rolloutPath: string;
  },
): boolean {
  return (
    a.threadId === b.threadId &&
    a.registryPath === b.registryPath &&
    a.sessionId === b.sessionId &&
    a.rolloutPath === b.rolloutPath
  );
}

/** Enforce legal state transitions; throws on illegal. */
export function assertLegalTransition(
  from: DescriptorState,
  to: DescriptorState,
  opts: { sameBinding?: boolean } = {},
): void {
  if (from === to && to === "ready" && opts.sameBinding === true) return;
  if (from === "opening" && (to === "ready" || to === "degraded" || to === "closed")) return;
  if (from === "ready" && (to === "degraded" || to === "closed")) return;
  if (from === "degraded" && to === "closed") return;
  if (from === "closed" && to === "closed") return;
  throw new Error(`illegal descriptor transition ${from} → ${to}`);
}

export function createOpeningDescriptor(path: string, io: DescriptorIo = defaultDescriptorIo()): RuntimeDescriptorV1 {
  const probed = io.readProcessIdentity(io.pid);
  if (!probed.ok) {
    throw new ProcessIdentityUnavailableError(
      "cannot establish OS process identity for runtime descriptor",
      probed.message,
    );
  }
  const identity = probed.identity;
  const now = io.nowMs();
  const desc: RuntimeDescriptorV1 = {
    version: DESCRIPTOR_VERSION,
    state: "opening",
    incarnation: `${io.pid}-${now}-${io.randomId()}`,
    wrapperPid: io.pid,
    wrapperStartedAtMs: now,
    processIdentity: identity,
    updatedAt: new Date(now).toISOString(),
  };
  publishAtomic(path, serialize(desc), io);
  return desc;
}

export function writeDescriptor(
  path: string,
  desc: RuntimeDescriptorV1,
  io: DescriptorIo = defaultDescriptorIo(),
): void {
  const next: RuntimeDescriptorV1 = {
    ...desc,
    version: DESCRIPTOR_VERSION,
    updatedAt: new Date(io.nowMs()).toISOString(),
  };
  publishAtomic(path, serialize(next), io);
}

export type DescriptorOwnerStatus =
  | { status: "live" }
  /** Kernel-proven: owner not found, or the pid now names another incarnation. */
  | { status: "gone"; reason: string }
  /** Liveness could not be established — never grounds to treat as stale. */
  | { status: "indeterminate"; reason: string };

/**
 * The descriptor owner check: exact stored identity against the live probe.
 * `gone` is proof the owner exited (or its pid was reused); anything the probe
 * cannot establish is `indeterminate`, and callers must fail closed on it.
 */
export function probeDescriptorOwner(
  storedIdentity: ProcessIdentity,
  io: Pick<DescriptorIo, "readProcessIdentity">,
): DescriptorOwnerStatus {
  const current = io.readProcessIdentity(storedIdentity.pid);
  if (!current.ok) {
    if (current.code === "not_found") {
      return { status: "gone", reason: "descriptor stale: owner process not found (exited or never existed)" };
    }
    // Indeterminate is not proof of staleness — refuse without claiming stale.
    return {
      status: "indeterminate",
      reason: `descriptor refused: cannot establish current OS process identity (fail closed): ${current.message}`,
    };
  }
  if (!identitiesEqual(storedIdentity, current.identity)) {
    return { status: "gone", reason: "descriptor stale: process identity mismatch (pid reuse or forged identity)" };
  }
  return { status: "live" };
}

export type LoadDescriptorResult = { ok: true; descriptor: RuntimeDescriptorV1 } | { ok: false; reason: string };

const STATES: ReadonlySet<string> = new Set(["opening", "ready", "degraded", "closed"]);

export function loadDescriptor(path: string, io: DescriptorIo = defaultDescriptorIo()): LoadDescriptorResult {
  if (path.trim() === "") {
    return { ok: false, reason: "descriptor path empty" };
  }
  if (!io.exists(path)) {
    return { ok: false, reason: "descriptor missing" };
  }
  let raw: string;
  try {
    raw = io.readFile(path);
  } catch (cause) {
    return {
      ok: false,
      reason: `descriptor unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "descriptor malformed JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "descriptor not an object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== DESCRIPTOR_VERSION) {
    return { ok: false, reason: `descriptor version unsupported: ${String(obj.version)}` };
  }
  if (typeof obj.state !== "string" || !STATES.has(obj.state)) {
    return { ok: false, reason: `descriptor state invalid: ${String(obj.state)}` };
  }
  if (typeof obj.incarnation !== "string" || obj.incarnation.length < 8) {
    return { ok: false, reason: "descriptor incarnation missing/weak" };
  }
  if (typeof obj.wrapperPid !== "number" || !Number.isInteger(obj.wrapperPid) || obj.wrapperPid <= 0) {
    return { ok: false, reason: "descriptor wrapperPid invalid" };
  }
  if (
    typeof obj.wrapperStartedAtMs !== "number" ||
    !Number.isFinite(obj.wrapperStartedAtMs) ||
    obj.wrapperStartedAtMs <= 0
  ) {
    return { ok: false, reason: "descriptor wrapperStartedAtMs invalid" };
  }
  if (typeof obj.updatedAt !== "string" || obj.updatedAt === "") {
    return { ok: false, reason: "descriptor updatedAt missing" };
  }

  const storedIdentity = parseStoredProcessIdentity(obj.processIdentity);
  if (storedIdentity === null) {
    return { ok: false, reason: "descriptor processIdentity missing/invalid" };
  }
  if (storedIdentity.pid !== obj.wrapperPid) {
    return { ok: false, reason: "descriptor processIdentity.pid disagrees with wrapperPid" };
  }

  // Owner check for any non-closed state that could still enable retrieval.
  // Closed is never ready for retrieval; allow inspect after owner death.
  if (obj.state === "ready" || obj.state === "opening" || obj.state === "degraded") {
    const owner = probeDescriptorOwner(storedIdentity, io);
    if (owner.status !== "live") return { ok: false, reason: owner.reason };
  }

  const desc: RuntimeDescriptorV1 = {
    version: DESCRIPTOR_VERSION,
    state: obj.state as DescriptorState,
    incarnation: obj.incarnation,
    wrapperPid: obj.wrapperPid,
    wrapperStartedAtMs: obj.wrapperStartedAtMs,
    processIdentity: storedIdentity,
    updatedAt: obj.updatedAt,
  };
  if (typeof obj.threadId === "string" && obj.threadId !== "") desc.threadId = obj.threadId;
  if (typeof obj.registryPath === "string" && obj.registryPath !== "") desc.registryPath = obj.registryPath;
  if (typeof obj.sessionId === "string" && obj.sessionId !== "") desc.sessionId = obj.sessionId;
  if (typeof obj.rolloutPath === "string" && obj.rolloutPath !== "") desc.rolloutPath = obj.rolloutPath;
  if (typeof obj.degradeReason === "string") desc.degradeReason = obj.degradeReason;
  if (typeof obj.tokenFamily === "string" && obj.tokenFamily !== "") desc.tokenFamily = obj.tokenFamily;
  return { ok: true, descriptor: desc };
}

/**
 * Load file state for revocation verification even when owner is dead (only
 * inspects published state, never treats ready as usable without identity).
 */
export function inspectDescriptorState(
  path: string,
  io: DescriptorIo = defaultDescriptorIo(),
): { exists: false } | { exists: true; state: DescriptorState } | { exists: true; unreadable: true } {
  if (!io.exists(path)) return { exists: false };
  try {
    const raw = io.readFile(path);
    const parsed = JSON.parse(raw) as { state?: string };
    if (typeof parsed.state === "string" && STATES.has(parsed.state)) {
      return { exists: true, state: parsed.state as DescriptorState };
    }
    return { exists: true, unreadable: true };
  } catch {
    return { exists: true, unreadable: true };
  }
}

export function assertReadyBinding(desc: RuntimeDescriptorV1): { ok: true } | { ok: false; reason: string } {
  if (desc.state !== "ready") {
    return { ok: false, reason: `descriptor state is ${desc.state}, need ready` };
  }
  if (desc.threadId === undefined || desc.threadId === "") {
    return { ok: false, reason: "descriptor ready but threadId missing" };
  }
  if (desc.registryPath === undefined || desc.registryPath === "") {
    return { ok: false, reason: "descriptor ready but registryPath missing" };
  }
  if (desc.sessionId === undefined || desc.sessionId === "") {
    return { ok: false, reason: "descriptor ready but sessionId missing" };
  }
  if (desc.rolloutPath === undefined || desc.rolloutPath === "") {
    return { ok: false, reason: "descriptor ready but rolloutPath missing" };
  }
  return { ok: true };
}

export function markReady(
  path: string,
  current: RuntimeDescriptorV1,
  binding: {
    threadId: string;
    registryPath: string;
    sessionId: string;
    rolloutPath: string;
  },
  io: DescriptorIo = defaultDescriptorIo(),
): RuntimeDescriptorV1 {
  const same = current.state === "ready" && bindingsEqual(current, binding);
  assertLegalTransition(current.state, "ready", { sameBinding: same });
  if (same) {
    // Idempotent republish of identical binding
    writeDescriptor(path, current, io);
    return current;
  }
  const next: RuntimeDescriptorV1 = {
    ...current,
    state: "ready",
    threadId: binding.threadId,
    registryPath: binding.registryPath,
    sessionId: binding.sessionId,
    rolloutPath: binding.rolloutPath,
  };
  delete next.degradeReason;
  writeDescriptor(path, next, io);
  return next;
}

export type RevocationResult =
  | { ok: true; kind: "absent" }
  | { ok: true; kind: "non_ready"; state: "degraded" | "closed" }
  | { ok: false; reason: string };

/**
 * Checked revocation: publish non-ready, attempt removal, prove safe outcome.
 * Safe = verified absence OR durable closed/degraded file (not ready).
 * Fatal if neither can be proven (ready may still be loadable).
 */
export function revokeCapability(
  path: string,
  current: RuntimeDescriptorV1 | undefined,
  target: "degraded" | "closed",
  reason: string | undefined,
  io: DescriptorIo = defaultDescriptorIo(),
): RevocationResult {
  // 1. Attempt atomic non-ready publication
  if (current !== undefined) {
    try {
      assertLegalTransition(current.state, target);
      const next: RuntimeDescriptorV1 = {
        ...current,
        state: target,
        ...(target === "degraded" && reason !== undefined ? { degradeReason: reason } : {}),
      };
      if (target === "closed") delete next.degradeReason;
      writeDescriptor(path, next, io);
    } catch {
      // publication failed — fall through to removal
    }
  }

  // 2. Attempt removal (unlink must throw on real failure)
  try {
    if (io.exists(path)) {
      io.unlink(path);
    }
  } catch {
    // removal failed — fall through to verification
  }

  // 3. Verify safe outcome
  if (!io.exists(path)) {
    return { ok: true, kind: "absent" };
  }
  const inspected = inspectDescriptorState(path, io);
  if (inspected.exists === true && "state" in inspected) {
    if (inspected.state === "degraded" || inspected.state === "closed") {
      return { ok: true, kind: "non_ready", state: inspected.state };
    }
    if (inspected.state === "ready") {
      return {
        ok: false,
        reason: "revocation unproven: descriptor still ready after publish/remove failure",
      };
    }
    // opening is not retrieval-ready but also not the durable non-ready we want
    return {
      ok: false,
      reason: `revocation unproven: descriptor still ${inspected.state}`,
    };
  }
  return {
    ok: false,
    reason: "revocation unproven: descriptor exists but state unreadable",
  };
}

export function markDegraded(
  path: string,
  current: RuntimeDescriptorV1,
  reason: string,
  io: DescriptorIo = defaultDescriptorIo(),
): RuntimeDescriptorV1 {
  assertLegalTransition(current.state, "degraded");
  const rev = revokeCapability(path, current, "degraded", reason, io);
  if (!rev.ok) {
    throw new Error(`markDegraded revocation failed: ${rev.reason}`);
  }
  if (rev.kind === "absent") {
    return { ...current, state: "degraded", degradeReason: reason };
  }
  return { ...current, state: rev.state, degradeReason: reason };
}

export function markClosed(
  path: string,
  current: RuntimeDescriptorV1,
  io: DescriptorIo = defaultDescriptorIo(),
): RuntimeDescriptorV1 {
  assertLegalTransition(current.state, "closed");
  const rev = revokeCapability(path, current, "closed", undefined, io);
  if (!rev.ok) {
    throw new Error(`markClosed revocation failed: ${rev.reason}`);
  }
  return { ...current, state: "closed" };
}

/** Immediate revoke to closed/absent — used on child exit before drain. */
export function revokeDescriptor(
  path: string,
  current: RuntimeDescriptorV1 | undefined = undefined,
  io: DescriptorIo = defaultDescriptorIo(),
): RevocationResult {
  return revokeCapability(path, current, "closed", undefined, io);
}

export function closeAndRemove(
  path: string,
  current: RuntimeDescriptorV1 | undefined,
  io: DescriptorIo = defaultDescriptorIo(),
): RevocationResult {
  return revokeCapability(path, current, "closed", undefined, io);
}

export interface StaleDescriptorSweep {
  /** Descriptors whose owner the probe proved gone; deleted. */
  removed: string[];
  /** Owner live — kept. */
  keptLive: number;
  /** Owner liveness unknown, or the descriptor unreadable/malformed — kept. */
  keptIndeterminate: number;
  /** Proven stale but the delete itself failed — left in place. */
  failed: string[];
  /** Session ids named by kept (live or indeterminate) descriptors. */
  keptSessionIds: Set<string>;
}

/**
 * Launch-time sweep of `$CC_LHC_HOME/runtime/*.json`. A killed wrapper (or a
 * killed handoff candidate) never runs closeAndRemove, so its descriptor
 * lingers after `loadDescriptor` already rejects it as stale. Delete exactly
 * those whose owner `probeDescriptorOwner` proves gone; keep live and
 * indeterminate ones, and anything this sweep cannot parse.
 */
export function sweepStaleRuntimeDescriptors(
  home: string = ccLhcHome(),
  io: DescriptorIo = defaultDescriptorIo(),
  listDir: (dir: string) => string[] = (dir) => readdirSync(dir),
): StaleDescriptorSweep {
  const result: StaleDescriptorSweep = {
    removed: [],
    keptLive: 0,
    keptIndeterminate: 0,
    failed: [],
    keptSessionIds: new Set(),
  };
  const dir = runtimeDir(home);
  let names: string[];
  try {
    names = listDir(dir);
  } catch {
    return result;
  }
  for (const name of names) {
    // Dotfiles are in-flight publishAtomic temps, never descriptors.
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    const path = join(dir, name);
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(io.readFile(path));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      obj = parsed as Record<string, unknown>;
    } catch {
      result.keptIndeterminate += 1;
      continue;
    }
    const keep = (kind: "live" | "indeterminate"): void => {
      if (kind === "live") result.keptLive += 1;
      else result.keptIndeterminate += 1;
      if (typeof obj.sessionId === "string" && obj.sessionId !== "") result.keptSessionIds.add(obj.sessionId);
    };
    const storedIdentity = parseStoredProcessIdentity(obj.processIdentity);
    if (storedIdentity === null || storedIdentity.pid !== obj.wrapperPid) {
      keep("indeterminate");
      continue;
    }
    const owner = probeDescriptorOwner(storedIdentity, io);
    if (owner.status !== "gone") {
      keep(owner.status);
      continue;
    }
    try {
      io.unlink(path);
      result.removed.push(path);
    } catch {
      if (io.exists(path)) result.failed.push(path);
      else result.removed.push(path);
    }
  }
  return result;
}
