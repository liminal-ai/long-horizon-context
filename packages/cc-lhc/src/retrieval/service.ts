/**
 * Shared retrieval service — descriptor bind, session check, SDK call, envelope.
 * CLI (and any future adapter) goes through this only; never invents thread/db.
 */

import { createDeterministicInferenceCallbacks, initLhc, type Lhc, retrieval, type ThreadRef } from "lhc";

import {
  assertReadyBinding,
  type DescriptorIo,
  defaultDescriptorIo,
  loadDescriptor,
  RUNTIME_DESCRIPTOR_ENV,
  type RuntimeDescriptorV1,
} from "../runtime/descriptor.js";
import { envStdoutCeiling, planByteBudget } from "./budget.js";
import { assembleEnvelope, messageSection, projectServedForEnvelope, turnSection } from "./format.js";
import type { ParsedRetrievalRequest, RetrievalOp } from "./parse.js";
import { parseRetrievalArgv } from "./parse.js";
import { defaultRolloutBindIo, type RolloutBindIo, verifyDescriptorRolloutBinding } from "./rollout-bind.js";

export const DEFAULT_TOKEN_BUDGET = retrieval.DEFAULT_RETRIEVAL_TOKEN_BUDGET;

export type RetrievalServiceResult =
  | {
      ok: true;
      /** Full stdout envelope; safe to print as a whole. */
      stdout: string;
      callId: string;
      bytes: number;
      impressionsExpected: number;
    }
  | {
      ok: false;
      /** stderr-facing refusal; no SDK call → zero impressions. */
      reason: string;
      usage?: string;
      /** 2 = syntax, 3 = binding/session/descriptor */
      exitCode: 2 | 3;
    };

export interface RetrievalServiceDeps {
  env?: NodeJS.ProcessEnv;
  descriptorIo?: DescriptorIo;
  rolloutBindIo?: RolloutBindIo;
  /** Test seam: inject SDK. */
  initSdk?: () => Lhc;
  /** Test seam: override descriptor path. */
  descriptorPath?: string;
  /**
   * Test seam: replace SDK retrieval methods (e.g. inject oversize body that
   * violates the host budget contract).
   */
  retrievalOverride?: {
    getTurns?: typeof retrieval.getTurns;
    getMessages?: typeof retrieval.getMessages;
  };
}

function liveSessionId(env: NodeJS.ProcessEnv): string | undefined {
  const v = env.CLAUDE_CODE_SESSION_ID;
  return v !== undefined && v !== "" ? v : undefined;
}

/**
 * Session mismatch gate.
 * - When CLAUDE_CODE_SESSION_ID is present: must equal descriptor.sessionId.
 * - When absent: independent rollout file existence + Slice 1 dual-field proof.
 */
export function checkSessionBinding(
  desc: RuntimeDescriptorV1,
  env: NodeJS.ProcessEnv,
  rolloutIo: RolloutBindIo = defaultRolloutBindIo(),
): { ok: true } | { ok: false; reason: string } {
  const binding = assertReadyBinding(desc);
  if (!binding.ok) return binding;

  const live = liveSessionId(env);
  if (live !== undefined) {
    if (live !== desc.sessionId) {
      return {
        ok: false,
        reason: `session mismatch: live CLAUDE_CODE_SESSION_ID=${live} descriptor=${desc.sessionId}`,
      };
    }
    return { ok: true };
  }

  return verifyDescriptorRolloutBinding(desc, rolloutIo);
}

function threadRefOf(desc: RuntimeDescriptorV1): ThreadRef {
  return { threadId: desc.threadId!, registryPath: desc.registryPath! };
}

/**
 * Bind to the wrapper's ready descriptor (LIM-146 shares this with `tasks`):
 * env-supplied path only, fail closed on any non-ready state, then the
 * session-mismatch/rollout cross-check. No thread or database id is ever
 * taken from argv.
 */
export function bindReadyDescriptor(deps: {
  env: NodeJS.ProcessEnv;
  descriptorIo: DescriptorIo;
  rolloutBindIo: RolloutBindIo;
  descriptorPath?: string;
}): { ok: true; descriptor: RuntimeDescriptorV1 } | { ok: false; reason: string; exitCode: 3 } {
  const path = deps.descriptorPath ?? deps.env[RUNTIME_DESCRIPTOR_ENV];
  if (path === undefined || path === "") {
    return {
      ok: false,
      reason: `${RUNTIME_DESCRIPTOR_ENV} not set — retrieval requires a bound wrapper session`,
      exitCode: 3,
    };
  }
  const loaded = loadDescriptor(path, deps.descriptorIo);
  if (!loaded.ok) return { ok: false, reason: loaded.reason, exitCode: 3 };
  const desc = loaded.descriptor;
  if (desc.state === "opening") {
    return { ok: false, reason: "descriptor state is opening — capture not ready", exitCode: 3 };
  }
  if (desc.state === "closed") return { ok: false, reason: "descriptor state is closed", exitCode: 3 };
  if (desc.state === "degraded") {
    return {
      ok: false,
      reason: `descriptor state is degraded${desc.degradeReason ? `: ${desc.degradeReason}` : ""}`,
      exitCode: 3,
    };
  }
  const ready = assertReadyBinding(desc);
  if (!ready.ok) return { ok: false, reason: ready.reason, exitCode: 3 };
  const session = checkSessionBinding(desc, deps.env, deps.rolloutBindIo);
  if (!session.ok) return { ok: false, reason: session.reason, exitCode: 3 };
  return { ok: true, descriptor: desc };
}

export async function executeRetrieval(
  argv: readonly string[],
  deps: RetrievalServiceDeps = {},
): Promise<RetrievalServiceResult> {
  const env = deps.env ?? process.env;
  const io = deps.descriptorIo ?? defaultDescriptorIo();
  const rolloutIo = deps.rolloutBindIo ?? defaultRolloutBindIo();

  // 1. Strict parse — zero impressions on failure.
  const parsed = parseRetrievalArgv(argv);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: parsed.reason,
      ...(parsed.usage !== undefined ? { usage: parsed.usage } : {}),
      exitCode: 2,
    };
  }
  const request = parsed.request;

  // 2–4. Descriptor from environment only; ready state; session cross-check.
  const bound = bindReadyDescriptor({
    env,
    descriptorIo: io,
    rolloutBindIo: rolloutIo,
    ...(deps.descriptorPath === undefined ? {} : { descriptorPath: deps.descriptorPath }),
  });
  if (!bound.ok) return bound;
  const desc = bound.descriptor;

  // 5. Budget: reserve envelope overhead; refuse if arithmetic leaves no body room.
  const plan = planByteBudget(request.op, request.uniqueIds.length, envStdoutCeiling(env));
  if (plan.sdkByteBudget === null) {
    return {
      ok: false,
      reason: `retrieval budget arithmetic failed: reserved ${plan.reservedOverhead} >= ceiling ${plan.stdoutCeiling}`,
      exitCode: 2,
    };
  }

  // 6. SDK call — impressions only from here.
  const sdk = (
    deps.initSdk ?? (() => initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() }))
  )();
  const ref = threadRefOf(desc);
  const surface = request.op === "get-turns" ? "cc-lhc:get-turns" : "cc-lhc:get-messages";
  const opts = {
    tokenBudget: DEFAULT_TOKEN_BUDGET,
    byteBudget: plan.sdkByteBudget,
    fromToken: request.fromToken,
    surface,
  };

  const getTurns = deps.retrievalOverride?.getTurns ?? sdk.retrieval.getTurns.bind(sdk.retrieval);
  const getMessages = deps.retrievalOverride?.getMessages ?? sdk.retrieval.getMessages.bind(sdk.retrieval);

  const result =
    request.op === "get-turns" ? await getTurns(ref, request.ids, opts) : await getMessages(ref, request.ids, opts);

  if (!result.ok) {
    // SDK caller_error after our validation is rare; treat as refusal (impressions
    // may or may not have been written — SDK only writes inside the successful tx).
    return { ok: false, reason: result.error.reason, exitCode: 2 };
  }

  const receipt = result.value;

  // Host projection: initial zero-served slices (from=0,to=0,total>0) become
  // actionable budget unserved lines — no second SDK call / impression.
  const servedEntities =
    request.op === "get-turns"
      ? (
          receipt.served as Array<{
            turnId: string;
            text: string;
            slice?: { fromToken: number; toToken: number; totalTokens: number };
          }>
        ).map((turn) => ({
          id: turn.turnId,
          text: turn.text,
          ...(turn.slice !== undefined ? { slice: turn.slice } : {}),
        }))
      : (
          receipt.served as Array<{
            messageId: string;
            text: string;
            slice?: { fromToken: number; toToken: number; totalTokens: number };
          }>
        ).map((msg) => ({
          id: msg.messageId,
          text: msg.text,
          ...(msg.slice !== undefined ? { slice: msg.slice } : {}),
        }));

  const projected = projectServedForEnvelope(request.op, servedEntities, receipt.unserved, (entity) =>
    request.op === "get-turns" ? turnSection(entity.text) : messageSection(entity.id, entity.text),
  );

  const stdout = assembleEnvelope(request.op, projected.sections, projected.footers, projected.unserved);
  const bytes = Buffer.byteLength(stdout, "utf8");

  // 7. Internal invariant: real SDK results under a positive plan must fit.
  // A contract-violating injected override may throw here after SDK impressions;
  // that is corruption of the SDK contract, not a pre-SDK zero-impression refusal.
  if (bytes > plan.stdoutCeiling) {
    throw new Error(`RETRIEVAL_ENVELOPE_INVARIANT: envelope ${bytes} exceeds ceiling ${plan.stdoutCeiling}`);
  }

  return {
    ok: true,
    stdout,
    callId: receipt.callId,
    bytes,
    impressionsExpected: request.uniqueIds.length,
  };
}

/**
 * Await a full write with conjunctive completion:
 * - write callback must complete successfully, and
 * - if write() returned false, drain must also be observed.
 * Resolve only when both required conditions hold. Reject on sync throw,
 * stream `error`, or callback error even if drain already fired.
 *
 * Listeners are registered *before* `write()` so a synchronous callback
 * (success or error) or drain-before-return cannot race attachment. Settlement
 * always removes this call's `error` and `drain` listeners — never attach after
 * settle (C9 leak: sync error callback cleaned up, then post-return `once(drain)`).
 */
export function writeAll(stream: NodeJS.WritableStream, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let writeCallComplete = false;
    let requiresDrain = false;
    let callbackOk = false;
    let drainSeen = false;

    const cleanup = () => {
      stream.off("error", onError);
      stream.off("drain", onDrain);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const maybeResolve = () => {
      if (settled) return;
      // Do not resolve until write() has returned so requiresDrain is known
      // (handles sync callback / drain before return).
      if (!writeCallComplete) return;
      if (!callbackOk) return;
      if (requiresDrain && !drainSeen) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onError = (err: Error) => fail(err);
    const onDrain = () => {
      drainSeen = true;
      maybeResolve();
    };

    // Pre-register before write so sync callback/error/drain are observed and
    // cleanup always owns the same handlers (no post-return attach).
    stream.once("error", onError);
    stream.once("drain", onDrain);

    try {
      const onCallback = (err?: Error | null) => {
        if (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        callbackOk = true;
        maybeResolve();
      };

      const ok = stream.write(data, onCallback);
      requiresDrain = !ok;
      writeCallComplete = true;
      // Attempt settle for: sync success + (true return | drain already seen).
      maybeResolve();
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** CLI entry: parse argv, run service, write streams (flush-safe). */
export async function runRetrievalCli(
  argv: readonly string[],
  streams: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  } = {},
  deps: RetrievalServiceDeps = {},
): Promise<number> {
  const out = streams.stdout ?? process.stdout;
  const err = streams.stderr ?? process.stderr;
  const result = await executeRetrieval(argv, deps);
  if (!result.ok) {
    await writeAll(err, `cc-lhc: ${result.reason}\n`);
    if (result.usage !== undefined) await writeAll(err, `${result.usage}\n`);
    return result.exitCode;
  }
  const payload = result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`;
  await writeAll(out, payload);
  return 0;
}

export function isRetrievalArgv(argv: readonly string[]): boolean {
  const head = argv[0];
  return head === "get-turns" || head === "get-messages";
}

export type { ParsedRetrievalRequest, RetrievalOp };
