import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeterministicInferenceCallbacks, initLhc, type Lhc, resolveTokenFamily, threads } from "lhc";
import { type Binding, openRecording, type Recorder, type Recording } from "../sidecar/src/capture/recorder.ts";
import type { CapturedMessage, CaptureEntry } from "../src/capture.ts";

export const SESSION = "11111111-2222-3333-4444-555555555555";

type Line = Record<string, unknown> & { uuid: string; parentUuid: string | null };

export class Script {
  readonly entries: CaptureEntry[] = [];
  readonly lines: Line[] = [];
  #parent: string | null = null;

  #row(
    door: string,
    message: CapturedMessage,
    line: Record<string, unknown>,
    extra: { origin?: string; model?: string } = {},
  ): string {
    const uuid = randomUUID();
    this.entries.push({
      kind: "row",
      sessionId: SESSION,
      uuid,
      door,
      origin: extra.origin ?? "composer",
      message,
      at: Date.now(),
      ...(extra.model === undefined ? {} : { model: extra.model }),
    });
    this.lines.push({ uuid, parentUuid: this.#parent, sessionId: SESSION, ...line });
    this.#parent = uuid;
    return uuid;
  }

  rewindTo(uuid: string): void {
    this.#parent = uuid;
  }

  prompt(text: string): string {
    const content = [{ type: "text", text }];
    return this.#row(
      "prompt",
      { type: "user", role: "user", content },
      { type: "user", message: { role: "user", content: text } },
    );
  }

  notification(text: string): string {
    const content = [{ type: "text", text }];
    return this.#row(
      "prompt",
      { type: "user", role: "user", content },
      { type: "user", origin: { kind: "task-notification" }, message: { role: "user", content: text } },
      { origin: "task-notification" },
    );
  }

  attachment(name: string, text: string, door = "attachment"): string {
    const content = [{ type: "text", text }];
    return this.#row(
      door,
      { type: "attachment", name, role: "user", content },
      { type: "attachment", attachment: { type: name } },
    );
  }

  steer(text: string): string {
    const content = [{ type: "text", text: `<system-reminder>The user sent: ${text}</system-reminder>` }];
    return this.#row(
      "attachment",
      { type: "attachment", name: "queued_command", role: "user", content },
      { type: "attachment", attachment: { type: "queued_command", prompt: text } },
    );
  }

  queued(text: string): void {
    this.entries.push({
      kind: "row",
      sessionId: SESSION,
      uuid: randomUUID(),
      door: "queue",
      origin: "human",
      message: { type: "user", role: "user", content: [{ type: "text", text }] },
      at: Date.now(),
    });
  }

  compactBoundary(): string {
    return this.#row(
      "compaction",
      { type: "system", name: "compact_boundary", content: [{ type: "text", text: "Conversation compacted" }] },
      { type: "system", subtype: "compact_boundary" },
    );
  }

  answer(...content: Array<Record<string, unknown>>): string {
    const message = { role: "assistant", model: "claude-opus-5-5", content };
    return this.#row(
      "response",
      { type: "assistant", role: "assistant", content },
      { type: "assistant", message },
      { model: "claude-opus-5-5" },
    );
  }

  results(...ids: string[]): string {
    const content = ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: `out ${id}` }));
    return this.#row(
      "tool-result",
      { type: "user", role: "user", content },
      { type: "user", message: { role: "user", content } },
    );
  }

  system(subtype: string): string {
    const uuid = randomUUID();
    this.lines.push({ uuid, parentUuid: this.#parent, type: "system", subtype });
    this.#parent = uuid;
    return uuid;
  }

  turnStart(turnId: string): void {
    this.entries.push({ kind: "turn-start", sessionId: SESSION, turnId, at: Date.now() });
  }

  step(turnId: string, index: number): void {
    this.entries.push({ kind: "step", sessionId: SESSION, turnId, index, at: Date.now() });
  }

  turnEnd(turnId: string): void {
    this.entries.push({
      kind: "turn-end",
      sessionId: SESSION,
      turnId,
      isAborted: false,
      reason: "answer",
      at: Date.now(),
    });
    this.system("turn_duration");
  }

  toolTurn(turnId: string, text: string, ...tools: string[]): void {
    this.prompt(text);
    this.attachment("date", "<system-reminder>Today is a day.</system-reminder>");
    this.turnStart(turnId);
    this.step(turnId, 0);
    this.answer(...tools.map((id) => ({ type: "tool_use", id, name: "Bash", input: { command: id } })));
    this.results(...tools);
    this.step(turnId, 1);
    this.answer({ type: "text", text: `done ${turnId}` });
    this.turnEnd(turnId);
  }
}

export type Harness = { lhc: Lhc; home: string; transcript: string; log: string[]; cleanup: () => void };

export function harness(): Harness {
  const home = mkdtempSync(join(tmpdir(), "cc-lhc-mod-capture-"));
  const lhc = initLhc({
    mode: "manual",
    inferenceCallbacks: createDeterministicInferenceCallbacks(),
    tokenFamily: resolveTokenFamily("", "anthropic").family,
  });
  return {
    lhc,
    home,
    transcript: join(home, `${SESSION}.jsonl`),
    log: [],
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

export function writeTranscript(h: Harness, lines: readonly Line[]): void {
  writeFileSync(h.transcript, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
}

export async function record(h: Harness, source = "startup", ownerPid = process.pid): Promise<Recording> {
  const binding: Binding = { sessionId: SESSION, transcriptPath: h.transcript, source };
  return openRecording({ lhc: h.lhc, home: h.home, ownerPid, log: (line) => h.log.push(line) }, binding);
}

export async function recorder(h: Harness): Promise<Recorder> {
  const recording = await record(h);
  if (recording.kind !== "recording") throw new Error(recording.notice);
  return recording.recorder;
}

export async function messages(r: Recorder): Promise<string[]> {
  const history = await threads.exportHistory(r.thread);
  if (!history.ok) throw new Error(history.error.reason);
  return history.value.turns.flatMap((turn) =>
    turn.messages.map((message) => {
      const content = (message.blocks[0]?.content ?? {}) as Record<string, unknown>;
      const label = content.text ?? content.toolCallId;
      return `${turn.turnId} ${message.kind}${content.steer === true ? " steer" : ""} ${String(label)}`;
    }),
  );
}

export async function events(r: Recorder): Promise<Map<string, Record<string, unknown>>> {
  const all = await r.deps.lhc.intakeStream.listEvents(r.thread);
  if (!all.ok) throw new Error(all.error.reason);
  return new Map(all.value.map((event) => [event.idempotencyKey, event.payload as Record<string, unknown>]));
}
