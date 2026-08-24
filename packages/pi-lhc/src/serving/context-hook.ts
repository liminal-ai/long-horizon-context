// The `context` hook (Design F, epic AC-7.2 / TC-7.2a,c,d,e): serve the LHC
// view to the provider mid-run through Pi's documented per-step context
// rewrite seam. No fork, no Pi state written, no third algorithm state.
//
// Per step, before the next LLM call:
//   1. flush pending capture to the seam (the step edge Pi just closed);
//   2. evaluate pressure — the last assistant message's provider-reported
//      context tokens plus LHC estimates for everything after it;
//   3. over the trigger → LHC mid-turn compact with the host seam assertion
//      (bounded by the same retry-after-growth rule as the settle trigger,
//      AC-7.5); a refusal is not a handler failure — serving continues;
//   4. serve the installed view whenever one exists (steady state): rendered
//      bands — parts and seam marker live inside them — then Pi's own message
//      objects from the first kept message on, located by tail-cut alignment
//      (align-context.ts); Pi's compactionSummary never survives the cut.
//   5. anything else — no installed view, capture not flushed, alignment
//      refused, a throw — serves `undefined`: the raw list, Pi's overflow
//      recovery as the backstop.
//
// Served-only durability (TC-7.2d): nothing here appends to the Pi session.
import { estimateTokens, type OpResult, type SessionThreadView, type ViewCompactParams } from "lhc";
import { AUTO_COMPACT_RETRY_GROWTH_TOKENS, shouldTriggerModelCompact } from "../compact/model-profiles.js";
import { mapFirstKeptToEntryId } from "../compact/result-mapping.js";
import type { LhcSeedEntryMap } from "../compact/seed-entry-map.js";
import type { SessionState } from "../lifecycle/state.js";
import type { AgentMessage, ContextEvent, ContextEventResult, ExtensionContext, SessionEntry } from "../pi/types.js";
import type { LhcInstance } from "../shared/instance.js";
import { alignTailStart } from "./align-context.js";

export type ContextServeOutcome =
  | { kind: "raw"; reason: string }
  | { kind: "served"; compacted: boolean; tailIndex: number; bands: number };

export interface ContextHookState {
  /** Context tokens at the last mid-turn attempt (compact ran or was refused);
   *  the next attempt waits for real growth (AC-7.5). */
  lastAttemptTokens: number | null;
}

export interface ContextHookDeps {
  state: SessionState | null;
  instance: LhcInstance | null;
  piSessionId: string | null;
  flushPendingCapture: (ctx: ExtensionContext) => Promise<void>;
  findSeedEntryMap: (branchEntries: readonly SessionEntry[], activeThreadId: string) => LhcSeedEntryMap | null;
  /** Per-model trigger; undefined → never compacts mid-turn (serving still runs). */
  triggerTokens: number | undefined;
  compactParams: ViewCompactParams;
  hookState: ContextHookState;
  /** Observability seam for tests and diagnostics. */
  onOutcome?: (outcome: ContextServeOutcome) => void;
}

// ── pressure ─────────────────────────────────────────────────────

function textOfParts(parts: unknown): string {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      const record = part as Record<string, unknown>;
      if (typeof record["text"] === "string") return record["text"];
      if (typeof record["thinking"] === "string") return record["thinking"];
      if (record["type"] === "toolCall")
        return `${String(record["name"] ?? "")}(${JSON.stringify(record["arguments"] ?? {})})`;
      return "";
    })
    .join("\n");
}

/** LHC's estimate for one Pi message object, whatever its role. */
export function estimateAgentMessageTokens(message: AgentMessage): number {
  const record = message as unknown as Record<string, unknown>;
  // Pi's list carries roles beyond the capture mirror's union.
  switch (String(record["role"])) {
    case "bashExecution":
      return estimateTokens(`${String(record["command"] ?? "")}\n${String(record["output"] ?? "")}`);
    case "compactionSummary":
    case "branchSummary":
      return estimateTokens(String(record["summary"] ?? ""));
    default:
      return estimateTokens(textOfParts(record["content"]));
  }
}

/** Provider-reported context tokens of an assistant message (Pi's
 *  calculateContextTokens), or null when the message carries no usable usage. */
function providerContextTokens(message: AgentMessage): number | null {
  if (message.role !== "assistant") return null;
  if (message.stopReason === "aborted" || message.stopReason === "error") return null;
  const usage = message.usage as
    | { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
    | undefined;
  if (usage === undefined || usage === null) return null;
  const total =
    usage.totalTokens || (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return total > 0 ? total : null;
}

/** Pressure at the seam: the last assistant message's provider-reported
 *  context tokens plus LHC estimates for every message after it; with no
 *  usable usage anywhere, LHC estimates for the whole list. */
export function estimateContextPressure(messages: readonly AgentMessage[]): number {
  let lastUsageIndex = -1;
  let usage = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const reported = providerContextTokens(messages[index] as AgentMessage);
    if (reported !== null) {
      lastUsageIndex = index;
      usage = reported;
      break;
    }
  }
  let since = 0;
  for (let index = lastUsageIndex + 1; index < messages.length; index += 1) {
    since += estimateAgentMessageTokens(messages[index] as AgentMessage);
  }
  return usage + since;
}

// ── serving ──────────────────────────────────────────────────────

function isBandEntry(
  entry: SessionThreadView["entries"][number],
): entry is { role: "user"; content: string; sourceMessages: [] } {
  return (
    "role" in entry &&
    entry.role === "user" &&
    entry.sourceMessages.length === 0 &&
    entry.content.startsWith("[context ·")
  );
}

function firstKeptMessageIdOf(view: SessionThreadView): string | null {
  for (const entry of view.entries) {
    if (!("role" in entry) || entry.sourceMessages.length === 0) continue;
    return entry.sourceMessages[0]?.messageId ?? null;
  }
  return null;
}

function bandMessage(content: string, timestamp: number): AgentMessage {
  return { role: "user", content, timestamp } as AgentMessage;
}

function timestampOf(message: AgentMessage | undefined): number {
  const stamp = (message as { timestamp?: unknown } | undefined)?.timestamp;
  return typeof stamp === "number" && Number.isFinite(stamp) ? stamp : 0;
}

export async function handleContext(
  event: ContextEvent,
  ctx: ExtensionContext,
  deps: ContextHookDeps,
): Promise<ContextEventResult | undefined> {
  const raw = (reason: string): undefined => {
    deps.onOutcome?.({ kind: "raw", reason });
    return undefined;
  };
  try {
    const { state, instance } = deps;
    if (state === null || instance === null) return raw("no active LHC thread");
    const sessionManager = ctx.sessionManager;
    if (sessionManager.buildContextEntries === undefined) return raw("PI session manager has no context entry list");

    // 1. The seam: everything Pi finalized in this step reaches the record.
    await deps.flushPendingCapture(ctx);
    if (state.health.lastCaptureFailure !== undefined) {
      return raw(`capture incomplete: ${state.health.lastCaptureFailure.message}`);
    }

    // 2–3. Pressure and the mid-turn compact.
    let compacted = false;
    const contextTokens = estimateContextPressure(event.messages);
    if (
      shouldTriggerModelCompact({
        contextTokens,
        triggerTokens: deps.triggerTokens,
        inFlight: false,
        lastAttemptTokens: deps.hookState.lastAttemptTokens,
        retryGrowthTokens: AUTO_COMPACT_RETRY_GROWTH_TOKENS,
      })
    ) {
      deps.hookState.lastAttemptTokens = contextTokens;
      const compact = await instance.sdk.threadView.midTurnCompact(state.threadRef, {
        seam: {
          // At Pi's `context` event the previous response is complete and its
          // tool results are in the list (the loop fires it before the next
          // LLM call); capture was flushed above with no failure.
          modelResponseComplete: true,
          requestedToolsSettled: true,
          captureFlushed: true,
          beforeNextProviderRequest: true,
        },
        params: deps.compactParams,
      });
      // A refusal or error is not a handler failure: the installed view (if
      // any) still serves, and the next attempt waits for growth.
      compacted = compact.ok;
    }

    // 4. Steady state: the installed view, whatever produced it.
    const view: OpResult<SessionThreadView> = await instance.sdk.threadView.getSessionThreadView(state.threadRef);
    if (!view.ok) return raw(`session view unavailable: ${view.error.reason}`);
    const bands = view.value.entries.filter(isBandEntry);
    if (bands.length === 0) return raw("no installed view");
    const firstKeptMessageId = firstKeptMessageIdOf(view.value);
    if (firstKeptMessageId === null) return raw("installed view keeps no mappable tail");

    const branchEntries = sessionManager.getBranch?.() ?? sessionManager.getEntries();
    const mapped = mapFirstKeptToEntryId(
      firstKeptMessageId,
      view.value,
      deps.findSeedEntryMap(branchEntries, view.value.threadId),
      branchEntries,
      deps.piSessionId ?? "",
    );
    if ("mappingFailed" in mapped) return raw(`first kept message not mapped: ${mapped.reason}`);

    const aligned = alignTailStart({
      firstKeptEntryId: mapped.firstKeptEntryId,
      contextEntries: sessionManager.buildContextEntries(),
      messages: event.messages,
    });
    if (!aligned.ok) return raw(`tail-cut alignment refused: ${aligned.reason}`);

    // The tail is Pi's own objects from step k+1; a compaction summary can
    // only sit before the cut, and never rides along.
    const tail = event.messages
      .slice(aligned.index)
      .filter((message) => String((message as { role: string }).role) !== "compactionSummary");
    const bandTimestamp = timestampOf(tail[0]) - 1;
    const served = [...bands.map((band) => bandMessage(band.content, bandTimestamp)), ...tail];
    deps.onOutcome?.({ kind: "served", compacted, tailIndex: aligned.index, bands: bands.length });
    return { messages: served };
  } catch (cause) {
    return raw(`context handler failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
