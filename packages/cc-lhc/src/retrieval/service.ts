import { createDeterministicInferenceCallbacks, initLhc, type Lhc, retrieval, type ThreadRef } from "lhc";

import { defaultSessionTokenFamily } from "../observation/token-family.js";

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
      stdout: string;
      callId: string;
      bytes: number;
      impressionsExpected: number;
    }
  | {
      ok: false;
      reason: string;
      usage?: string;
      exitCode: 2 | 3;
    };

export interface RetrievalServiceDeps {
  env?: NodeJS.ProcessEnv;
  descriptorIo?: DescriptorIo;
  rolloutBindIo?: RolloutBindIo;
  initSdk?: () => Lhc;
  descriptorPath?: string;
  retrievalOverride?: {
    getTurns?: typeof retrieval.getTurns;
    getMessages?: typeof retrieval.getMessages;
  };
}

function liveSessionId(env: NodeJS.ProcessEnv): string | undefined {
  const v = env.CLAUDE_CODE_SESSION_ID;
  return v !== undefined && v !== "" ? v : undefined;
}

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

  const bound = bindReadyDescriptor({
    env,
    descriptorIo: io,
    rolloutBindIo: rolloutIo,
    ...(deps.descriptorPath === undefined ? {} : { descriptorPath: deps.descriptorPath }),
  });
  if (!bound.ok) return bound;
  const desc = bound.descriptor;

  const plan = planByteBudget(request.op, request.uniqueIds.length, envStdoutCeiling(env));
  if (plan.sdkByteBudget === null) {
    return {
      ok: false,
      reason: `retrieval budget arithmetic failed: reserved ${plan.reservedOverhead} >= ceiling ${plan.stdoutCeiling}`,
      exitCode: 2,
    };
  }

  const sdk = (
    deps.initSdk ??
    (() =>
      initLhc({
        mode: "manual",
        tokenFamily: desc.tokenFamily ?? defaultSessionTokenFamily().family,
        inferenceCallbacks: createDeterministicInferenceCallbacks(),
      }))
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
    return { ok: false, reason: result.error.reason, exitCode: 2 };
  }

  const receipt = result.value;

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
      maybeResolve();
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

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
