import type { EngineInterface } from "claude-code";
import type { CompactOp } from "../../src/compact.ts";
import { type ActionKind, type ExportAnswer, type Health, kilo, type LastCompact, parseSetting, SETTING_NAMES } from "../../src/panel.ts";
import type { Settings } from "../../src/settings.ts";
import { requestCompact, unprunedOutcome } from "./compact.ts";
import { applySettings, setOption } from "./policy.ts";
import { boundSession, drainOutbox, get, log, post } from "./sidecar.ts";
import { publishBestEffort, readPanel } from "./state.ts";

const RUNNING: Record<ActionKind, string> = {
  compact: "Compacting...",
  prune: "Pruning older tool output...",
  export: "Exporting the thread...",
  settings: "Saving...",
};


async function runAsPaneAction($: EngineInterface, kind: ActionKind, run: () => Promise<string>): Promise<string> {
  await publishBestEffort($, { action: { kind, state: "running", text: RUNNING[kind], at: Date.now() } });
  try {
    const text = await run();
    await publishBestEffort($, { action: { kind, state: "done", text, at: Date.now() } });
    return text;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    log($, `${kind} failed: ${text}`);
    await publishBestEffort($, { action: { kind, state: "failed", text, at: Date.now() } });
    return text;
  }
}

function describeCompact(last: LastCompact, op: CompactOp): string {
  if (last.by === "native") return `LHC fell back to Claude Code's summary: ${last.reason}.`;
  const from = last.before === undefined ? "" : ` ${kilo(last.before)}`;
  return `${op === "prune" ? "Pruned" : "Compacted"}${from} to ${kilo(last.after)}.`;
}

/**
 * Runs `/compact` as the person would: `$.session.compact` skips the calling
 * plugin's own hooks, so LHC would not answer it.
 */
let compactions: Promise<unknown> = Promise.resolve();

/** One `/compact` at a time: each carries its own op to the hook. */
export function compactNow($: EngineInterface, op: CompactOp): Promise<string> {
  const ran = compactions.then(() => compactOnce($, op));
  compactions = ran;
  return ran;
}

function compactOnce($: EngineInterface, op: CompactOp): Promise<string> {
  return runAsPaneAction($, op, async () => {
    const started = Date.now();
    requestCompact(op);
    let shown: string | undefined;
    let unpruned: ReturnType<typeof unprunedOutcome>;
    try {
      shown = (await $.command.run({ command: "compact" })).text;
      unpruned = unprunedOutcome();
    } finally {
      requestCompact(undefined);
    }
    if (unpruned?.isNoOp === true) return `Nothing to prune: ${unpruned.reason}.`;
    if (unpruned !== undefined) throw new Error(`LHC did not prune: ${unpruned.reason}.`);
    const { lastCompact } = await readPanel($);
    if (lastCompact === null || lastCompact.at < started) throw new Error(shown ?? `LHC did not ${op}.`);
    return describeCompact(lastCompact, op);
  });
}

export function exportThread($: EngineInterface): Promise<string> {
  return runAsPaneAction($, "export", async () => {
    const sessionId = boundSession();
    if (sessionId === undefined) throw new Error("No session is bound to an LHC thread yet.");
    if (!(await drainOutbox($))) throw new Error("The thread's newest rows could not reach the sidecar, so nothing was exported.");
    const { path, turns } = (await post($, "/export", { sessionId })) as ExportAnswer;
    return `Exported ${turns} turns to ${path}`;
  });
}

/**
 * Applies the edits at once, then writes them to the plugin's `userConfig`.
 * Claude Code reloads the plugin when its options change, so the write comes
 * last: the reload's own start applies the same settings again.
 */
export async function editSettings(
  $: EngineInterface,
  edits: ReadonlyArray<{ field: keyof Settings; value: number }>,
): Promise<string> {
  const text = await runAsPaneAction($, "settings", async () => {
    for (const { field, value } of edits) setOption(field, value);
    applySettings($, "panel");
    const saved = edits.map(({ field, value }) => `${SETTING_NAMES[field]} ${field === "compactPercent" ? `${value}%` : kilo(value)}`);
    return `Saved ${saved.join(", ")}.`;
  });
  for (const { field, value } of edits) {
    const written = await $.config.set({ key: `lhc.${field}`, value });
    if (written.deny !== undefined) {
      return runAsPaneAction($, "settings", async () => {
        throw new Error(`The ${SETTING_NAMES[field]} applies to this session only: ${written.deny}`);
      });
    }
  }
  return text;
}

export function editSetting($: EngineInterface, field: keyof Settings, text: string): Promise<string> {
  const edit = parseSetting(field, text);
  if ("error" in edit) {
    return runAsPaneAction($, "settings", async () => {
      throw new Error(edit.error);
    });
  }
  return editSettings($, [edit]);
}

export async function refresh($: EngineInterface): Promise<void> {
  const health = (await get($, "/health")) as Health;
  const { recording, derivations } = health;
  const thread = recording?.threadId === undefined ? {} : { thread: { id: recording.threadId, how: recording.how ?? "" } };
  const tokens = (await $.session.usage({ breakdown: "summary" })).context.breakdown?.totalTokens;
  await publishBestEffort($, { derivations, ...thread, ...(tokens === undefined ? {} : { context: tokens }) });
}
