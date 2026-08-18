/**
 * LIM-67: protected visibility-boundary preview, override rendering,
 * atomic view+boundary install, and canonical message stability.
 */
import { afterEach, describe, expect, it } from "vitest";
import { initLhc, type Lhc, type MessageEventInput } from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  setViewInjectionHook,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

function tokens(n: number): string {
  return Array<string>(n).fill("tok").join(" ");
}

const stores: TempStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.cleanup();
});

function sdk(): Lhc {
  return initLhc({
    inferenceCallbacks: createInferenceCallbacksDouble(),
    mode: "manual",
    view: { visibility: { maxTokens: 500, targetTokens: 80 } },
  });
}

async function newThread(lhc: Lhc): Promise<string> {
  const store = tempStore();
  stores.push(store);
  const filePath = store.threadPath();
  const created = await lhc.threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(created.error.reason);
  return filePath;
}

let callCounter = 0;
function toolPair(resultTokens: number, id?: string): MessageEventInput[] {
  callCounter += 1;
  const toolCallId = id ?? `call-pb-${callCounter}`;
  return [
    validEvent("tool_call", {
      payload: { toolCallId, toolName: "read_file", arguments: { path: `${toolCallId}.txt` } },
    }),
    validEvent("tool_result", {
      payload: { toolCallId, content: tokens(resultTokens), isError: false },
    }),
  ];
}

async function intake(lhc: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await lhc.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(result.error.reason);
}

function abridgedCount(messages: ReadonlyArray<{ content: readonly { text: string }[] }>): number {
  return messages.filter((m) => {
    const text = m.content.map((p) => p.text).join("");
    return text.startsWith("[tool result · ") && text.includes(" · abridged]");
  }).length;
}

describe("LIM-67 protected boundary preview", () => {
  it("is read-only, monotonic, and strictly before earliest protected result", async () => {
    const lhc = sdk();
    const filePath = await newThread(lhc);
    // Closed history with large unprotected results, then open turn with protected pair.
    await intake(lhc, filePath, [
      validEvent("user_prompt", { payload: { text: "old" } }),
      ...toolPair(40, "call-old-1"),
      ...toolPair(40, "call-old-2"),
      ...toolPair(40, "call-old-3"),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: "open" } }),
      ...toolPair(30, "call-prot-a"),
      ...toolPair(30, "call-prot-b"),
    ]);

    const beforeBoundary = await lhc.threadView.status({ filePath });
    expect(beforeBoundary.ok).toBe(true);
    if (!beforeBoundary.ok) return;
    const prev = beforeBoundary.value.visibility.boundaryPosition;

    const preview = await lhc.threadView.previewProtectedBoundary(
      { filePath },
      {
        protectedToolCallIds: ["call-prot-a", "call-prot-b"],
        targetZoneTokens: 50,
      },
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.previousBoundary).toBe(prev);
    expect(preview.value.proposedBoundary).toBeGreaterThanOrEqual(prev);
    expect(preview.value.earliestProtectedResultOrder).not.toBeNull();
    expect(preview.value.proposedBoundary).toBeLessThan(preview.value.earliestProtectedResultOrder!);
    expect(preview.value.protectedToolCallIds).toEqual(["call-prot-a", "call-prot-b"]);
    expect(preview.value.fullProtectedTokenEstimate).toBeGreaterThan(0);

    // Durable boundary unchanged (read-only).
    const after = await lhc.threadView.status({ filePath });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.visibility.boundaryPosition).toBe(prev);
  });

  it("atomic install advances view and boundary together; rollback leaves both intact", async () => {
    const lhc = sdk();
    const filePath = await newThread(lhc);
    await intake(lhc, filePath, [
      validEvent("user_prompt", { payload: { text: "t1" } }),
      ...toolPair(50, "old-1"),
      ...toolPair(50, "old-2"),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: "t2" } }),
      ...toolPair(20, "prot-1"),
    ]);

    const status0 = await lhc.threadView.status({ filePath });
    expect(status0.ok).toBe(true);
    if (!status0.ok) return;
    const prevBoundary = status0.value.visibility.boundaryPosition;
    const prevView = await lhc.threadView.describe({ filePath });
    const prevViewId = prevView.ok ? (prevView.value?.viewId ?? null) : null;

    const preview = await lhc.threadView.previewProtectedBoundary(
      { filePath },
      { protectedToolCallIds: ["prot-1"], targetZoneTokens: 30 },
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const prepared = await lhc.threadView.prepareCompact({ filePath });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const installed = await lhc.threadView.installPreparedCompact({ filePath }, prepared.value, {
      visibilityBoundary: preview.value.proposedBoundary,
      expectedPreviousBoundary: prevBoundary,
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;

    const status1 = await lhc.threadView.status({ filePath });
    expect(status1.ok).toBe(true);
    if (!status1.ok) return;
    expect(status1.value.visibility.boundaryPosition).toBe(preview.value.proposedBoundary);
    expect(status1.value.visibility.boundaryPosition).toBeGreaterThanOrEqual(prevBoundary);

    const context = await lhc.threadView.getLlmRequestContext({ filePath });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    // Protected result remains full (not abridged) when present in rendered context.
    const texts = context.value.messages.map((m) => m.content.map((c) => c.text).join(""));
    const abridged = texts.filter((t) => t.includes(" · abridged]"));
    // All abridged rows (if any) must be older unprotected results only.
    for (const t of abridged) {
      expect(t.includes("prot-1")).toBe(false);
    }

    // Canonical messages remain verbatim (full tool result bodies in getMessages).
    const msgs = await lhc.messages.list({ filePath });
    expect(msgs.ok).toBe(true);
    if (!msgs.ok) return;
    const toolResults = msgs.value.filter((m) => m.kind === "tool_result");
    expect(toolResults.length).toBeGreaterThan(0);
    // Canonical content is not abridged by visibility boundary.
    for (const m of toolResults) {
      const body = JSON.stringify(m);
      expect(body.includes(" · abridged]")).toBe(false);
    }

    // A pinned boundary that has since moved recomputes against fresh state
    // and installs, instead of handing the host a refusal.
    const prepared2 = await lhc.threadView.prepareCompact({ filePath });
    expect(prepared2.ok).toBe(true);
    if (!prepared2.ok) return;
    const drifted = await lhc.threadView.installPreparedCompact({ filePath }, prepared2.value, {
      visibilityBoundary: preview.value.proposedBoundary + 1,
      expectedPreviousBoundary: prevBoundary, // stale: the first install already advanced it
    });
    expect(drifted.ok).toBe(true);
    if (!drifted.ok) return;

    const installedView = await lhc.threadView.describe({ filePath });
    expect(installedView.ok).toBe(true);
    if (!installedView.ok) return;
    expect(installedView.value?.viewId).toBe(drifted.value.viewId);

    const status2 = await lhc.threadView.status({ filePath });
    expect(status2.ok).toBe(true);
    if (!status2.ok) return;
    // Forward only: never behind the boundary already installed, never behind
    // the compact point it was installed with.
    expect(status2.value.visibility.boundaryPosition).toBeGreaterThanOrEqual(preview.value.proposedBoundary);
    expect(status2.value.visibility.boundaryPosition).toBeGreaterThanOrEqual(drifted.value.compactPoint);

    void prevViewId;
    void abridgedCount;
  });

  it("a boundary proposal computed against older state is resolved forward, not refused", async () => {
    const lhc = sdk();
    const filePath = await newThread(lhc);
    await intake(lhc, filePath, [
      validEvent("user_prompt", { payload: { text: "t1" } }),
      ...toolPair(50, "fwd-1"),
      ...toolPair(50, "fwd-2"),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: "t2" } }),
      ...toolPair(20, "fwd-3"),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: "t3" } }),
      ...toolPair(20, "fwd-4"),
    ]);

    const params = { lowerBound: 100, percentages: { full: 20, smooth: 40, detailed: 20, brief: 20 } };
    const first = await lhc.threadView.compact({ filePath }, { params });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const status1 = await lhc.threadView.status({ filePath });
    expect(status1.ok).toBe(true);
    if (!status1.ok) return;
    const boundaryBefore = status1.value.visibility.boundaryPosition;
    expect(boundaryBefore).toBeGreaterThan(0);

    const prepared = await lhc.threadView.prepareCompact({ filePath }, { params });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    // Boundary 0 is behind both the durable boundary and the compact point —
    // the shape a proposal takes when the state it was computed from has moved.
    const installed = await lhc.threadView.installPreparedCompact({ filePath }, prepared.value, {
      visibilityBoundary: 0,
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;

    const status2 = await lhc.threadView.status({ filePath });
    expect(status2.ok).toBe(true);
    if (!status2.ok) return;
    expect(status2.value.visibility.boundaryPosition).toBe(Math.max(boundaryBefore, installed.value.compactPoint));
  });

  it("a failing install leaves the prior view and boundary exactly as they were", async () => {
    const lhc = sdk();
    const filePath = await newThread(lhc);
    await intake(lhc, filePath, [
      validEvent("user_prompt", { payload: { text: "t1" } }),
      ...toolPair(50, "old-1"),
      ...toolPair(50, "old-2"),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: "t2" } }),
      ...toolPair(20, "prot-1"),
    ]);

    const first = await lhc.threadView.compact({ filePath }, {});
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const priorView = await lhc.threadView.describe({ filePath });
    expect(priorView.ok).toBe(true);
    if (!priorView.ok) return;
    const priorStatus = await lhc.threadView.status({ filePath });
    expect(priorStatus.ok).toBe(true);
    if (!priorStatus.ok) return;
    const priorContext = await lhc.threadView.getLlmRequestContext({ filePath });
    expect(priorContext.ok).toBe(true);
    if (!priorContext.ok) return;

    const prepared = await lhc.threadView.prepareCompact({ filePath });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    // A real storage failure inside the install transaction, not a policy stop.
    setViewInjectionHook("compact-install-before-validate", () => {
      throw new Error("injected storage failure inside the install transaction");
    });
    let failed: Awaited<ReturnType<typeof lhc.threadView.installPreparedCompact>>;
    try {
      failed = await lhc.threadView.installPreparedCompact({ filePath }, prepared.value);
    } finally {
      setViewInjectionHook("compact-install-before-validate", null);
    }
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error.errorClass).toBe("system_error");

    const afterView = await lhc.threadView.describe({ filePath });
    expect(afterView.ok).toBe(true);
    if (!afterView.ok) return;
    expect(afterView.value?.viewId).toBe(priorView.value?.viewId);
    const afterStatus = await lhc.threadView.status({ filePath });
    expect(afterStatus.ok).toBe(true);
    if (!afterStatus.ok) return;
    expect(afterStatus.value.visibility.boundaryPosition).toBe(priorStatus.value.visibility.boundaryPosition);
    const afterContext = await lhc.threadView.getLlmRequestContext({ filePath });
    expect(afterContext.ok).toBe(true);
    if (!afterContext.ok) return;
    expect(JSON.stringify(afterContext.value.messages)).toBe(JSON.stringify(priorContext.value.messages));
  });
});
