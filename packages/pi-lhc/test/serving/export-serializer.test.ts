import type { LlmRequestContextMessage } from "lhc";
import { describe, expect, it } from "vitest";
import type { AgentMessage, SessionEntry } from "../../src/pi/types.js";
import {
  agentMessageToExportEntry,
  llmRequestContextMessagesToExportEntries,
  llmRequestContextMessageToExportEntry,
  piSessionEntriesToExportEntries,
  serializeContentPart,
  serializeExportEntries,
} from "../../src/serving/export-serializer.js";
import { makeAssistantMessage, makeToolResult, makeUserMessage } from "../fixtures/synthetic.js";

describe("serializeExportEntries", () => {
  it("writes role headers and preserves raw content without trimming", () => {
    const text = "  leading space\n\ntrailing space  ";
    expect(
      serializeExportEntries([
        { role: "user", text },
        { role: "assistant", text: "" },
      ]),
    ).toBe(`[user]\n${text}\n\n[assistant]\n\n`);
  });
});

describe("serializeContentPart", () => {
  it("renders tool calls with stable sorted JSON arguments", () => {
    expect(
      serializeContentPart({
        type: "toolCall",
        id: "call-1",
        name: "read_file",
        arguments: { path: "a.txt", mode: "r" },
      }),
    ).toBe('[tool call · read_file] {"mode":"r","path":"a.txt"}');
  });
});

describe("cross-source export parity", () => {
  it("maps plain user text identically from LHC and PI shapes", () => {
    const lhc: LlmRequestContextMessage = {
      role: "user",
      content: [{ type: "text", text: "please read the file" }],
    };
    const pi = makeUserMessage("please read the file");

    expect(llmRequestContextMessageToExportEntry(lhc)).toEqual(agentMessageToExportEntry(pi));
  });

  it("maps assistant tool-call text identically when LHC pre-renders PI-shaped parts", () => {
    const rendered = '[tool call · read_file] {"path":"notes.txt"}';
    const lhc: LlmRequestContextMessage = {
      role: "assistant",
      content: [{ type: "text", text: rendered }],
    };
    const pi = makeAssistantMessage({
      toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "notes.txt" } }],
    });

    expect(llmRequestContextMessageToExportEntry(lhc)).toEqual(agentMessageToExportEntry(pi));
  });

  it("maps tool-result text identically from LHC and PI shapes", () => {
    const rendered = "[tool result · read_file]\ncontents of notes.txt";
    const lhc: LlmRequestContextMessage = {
      role: "user",
      content: [{ type: "text", text: rendered }],
    };
    const pi = {
      ...makeToolResult({ id: "call-1", content: "contents of notes.txt" }),
      toolName: "read_file",
    } as AgentMessage;

    expect(llmRequestContextMessageToExportEntry(lhc)).toEqual({
      role: "user",
      text: "[tool result · read_file]\ncontents of notes.txt",
    });
    expect(agentMessageToExportEntry(pi)).toEqual({
      role: "user",
      text: "[tool result · read_file]\ncontents of notes.txt",
    });
  });

  it("produces identical serialized bytes for equivalent LHC and PI sequences", () => {
    const lhcMessages: LlmRequestContextMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: '[tool call · bash] {"command":"ls"}' }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "[tool result · bash]\nfile.txt" }],
      },
    ];
    const piEntries: SessionEntry[] = [
      { type: "message", id: "m1", message: makeUserMessage("hi") },
      {
        type: "message",
        id: "m2",
        message: makeAssistantMessage({ toolCalls: [{ id: "c1", name: "bash", arguments: { command: "ls" } }] }),
      },
      {
        type: "message",
        id: "m3",
        message: { ...makeToolResult({ id: "c1", content: "file.txt" }), toolName: "bash" } as AgentMessage,
      },
      { type: "model_change", id: "mc1", provider: "openai", modelId: "gpt-test" },
    ];

    const fromLhc = serializeExportEntries(llmRequestContextMessagesToExportEntries(lhcMessages));
    const fromPi = serializeExportEntries(piSessionEntriesToExportEntries(piEntries));
    expect(fromPi).toBe(fromLhc);
  });
});
