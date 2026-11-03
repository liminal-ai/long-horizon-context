import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeterministicInferenceCallbacks, initLhc, type Lhc, resolveTokenFamily, threads } from "lhc";
import { type Binding, openRecording, type Recorder, type Recording } from "../sidecar/src/capture/recorder.ts";
import { createSidecarServer, type SidecarState } from "../sidecar/src/server.ts";
import type { CapturedMessage, CaptureEntry } from "../src/capture.ts";
import type { BuiltMessage } from "../src/compact.ts";

export const SESSION = "11111111-2222-3333-4444-555555555555";

type Line = Record<string, unknown> & { uuid: string; parentUuid: string | null };

export class Script {
  readonly entries: CaptureEntry[] = [];
  readonly lines: Line[] = [];
  #parent: string | null = null;
  #opener: string | undefined;
  readonly #turns = new Map<string, string>();

  #row(
    door: string,
    message: CapturedMessage,
    line: Record<string, unknown>,
    extra: { origin?: string; model?: string } = {},
  ): string {
    const uuid = randomUUID();
    if (door === "prompt" || door === "command" || door === "delivery") this.#opener = uuid;
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
      { type: "user", origin: { kind: "human" }, message: { role: "user", content: text } },
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

  /** A background task's notification delivered into a running turn, as Claude Code renders and files it. */
  delivery(
    notification: string,
    attachmentOrigin: Record<string, unknown> = { kind: "task-notification", producer: "session-task" },
  ): string {
    const rendered = `<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\n\n${notification}\n</system-reminder>`;
    return this.#row(
      "delivery",
      { type: "attachment", name: "queued_command", role: "user", content: [{ type: "text", text: rendered }] },
      {
        type: "attachment",
        attachment: {
          type: "queued_command",
          commandMode: "task-notification",
          origin: attachmentOrigin,
          prompt: notification,
        },
      },
      { origin: "task-notification" },
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

  /**
   * A native `/compact` as the transcript files it: the command note, then a
   * boundary with no parent whose logical parent skips the note, then the summary.
   */
  nativeCompaction(): void {
    const before = this.#parent;
    this.#row(
      "note",
      { type: "user", role: "user", content: [{ type: "text", text: "/compact" }] },
      { type: "user", message: { role: "user", content: "/compact" } },
    );
    const boundary = randomUUID();
    this.lines.push({
      uuid: boundary,
      parentUuid: null,
      logicalParentUuid: before,
      type: "system",
      subtype: "compact_boundary",
    });
    const summary = randomUUID();
    this.lines.push({
      uuid: summary,
      parentUuid: boundary,
      type: "user",
      isCompactSummary: true,
      message: { role: "user", content: "Summary of the conversation so far" },
    });
    this.#parent = summary;
    for (const content of [
      "<local-command-caveat>The command below was run by the user.</local-command-caveat>",
      "<command-name>/compact</command-name>",
      "<local-command-stdout>Compacted</local-command-stdout>",
    ]) {
      const uuid = randomUUID();
      this.lines.push({ uuid, parentUuid: this.#parent, type: "user", message: { role: "user", content } });
      this.#parent = uuid;
    }
  }

  compactBoundary(): string {
    return this.#row(
      "compaction",
      { type: "system", name: "compact_boundary", content: [{ type: "text", text: "Conversation compacted" }] },
      { type: "system", subtype: "compact_boundary", parentUuid: null, logicalParentUuid: this.#parent },
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

  /**
   * Turns are named as the mod names them: by the uuid of the prompt or
   * command row that opened them. Tests keep a short name for each.
   */
  turnId(name: string): string {
    return this.#turns.get(name) ?? name;
  }

  installed(messages: readonly BuiltMessage[]): string[] {
    return messages.map((message) => {
      if (message.role === "assistant") {
        const content = [
          ...(message.text === "" ? [] : [{ type: "text", text: message.text }]),
          ...message.toolUses.map((use) => ({
            type: "tool_use",
            id: use.tool_use_id,
            name: use.tool,
            input: use.input,
          })),
        ];
        return this.#row(
          "response",
          { type: "assistant", role: "assistant", content },
          { type: "assistant", message: { role: "assistant", content } },
          { origin: "model" },
        );
      }
      if (message.toolResults !== undefined) {
        const content = message.toolResults.map((r) => ({
          type: "tool_result",
          tool_use_id: r.tool_use_id,
          content: r.text,
        }));
        return this.#row(
          "tool-result",
          { type: "user", role: "user", content },
          { type: "user", message: { role: "user", content } },
        );
      }
      const content = [{ type: "text", text: message.text }];
      return this.#row(
        "note",
        { type: "user", role: "user", content },
        { type: "user", message: { role: "user", content: message.text } },
        { origin: "engine" },
      );
    });
  }

  /** A line Claude Code files by the note door, such as the plain text of a typed `/compact`. */
  note(text: string): string {
    const content = [{ type: "text", text }];
    return this.#row(
      "note",
      { type: "user", role: "user", content },
      { type: "user", message: { role: "user", content: text } },
      { origin: "engine" },
    );
  }

  nativeSummary(text: string): string {
    const content = [{ type: "text", text }];
    return this.#row(
      "compaction",
      { type: "user", role: "user", content },
      { type: "user", isCompactSummary: true, message: { role: "user", content: text } },
      { origin: "engine" },
    );
  }

  turnStart(name: string): void {
    this.#turns.set(name, this.#opener ?? name);
    this.#opener = undefined;
    this.entries.push({ kind: "turn-start", sessionId: SESSION, turnId: this.turnId(name), at: Date.now() });
  }

  step(name: string, index: number): void {
    this.entries.push({ kind: "step", sessionId: SESSION, turnId: this.turnId(name), index, at: Date.now() });
  }

  turnEnd(name: string): void {
    this.entries.push({
      kind: "turn-end",
      sessionId: SESSION,
      turnId: this.turnId(name),
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

/** A recorder bound as the mod binds after a sidecar restart in the same Claude process. */
export async function recorder(h: Harness): Promise<Recorder> {
  const recording = await record(h, "restart");
  if (recording.kind !== "recording") throw new Error(JSON.stringify(recording));
  return recording.recorder;
}

export async function messages(r: Pick<Recorder, "thread">): Promise<string[]> {
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

export type Served = {
  state: SidecarState;
  call: (path: string, body?: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;
  close: () => Promise<void>;
};

export async function serve(h: Harness): Promise<Served> {
  const socketPath = join(h.home, "test.sock");
  const { server, state } = createSidecarServer({
    lhc: h.lhc,
    home: h.home,
    ownerPid: process.pid,
    log: (line) => h.log.push(line),
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const call: Served["call"] = (path, body) =>
    new Promise((resolve, reject) => {
      const req = request({ socketPath, method: body === undefined ? "GET" : "POST", path }, (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown> }),
        );
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const close = async (): Promise<void> => {
    if (state.recording?.kind === "recording") state.recording.recorder.release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { state, call, close };
}
