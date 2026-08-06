// Smooth-history labels: short XML tags whose name is the entity id
// (<t1>…</t1>, <m2>…</m2>). turn_rendering carries them; pre_detailed_assembly
// (compression input) does not.
import { describe, expect, it } from "vitest";
import {
  type ComposeMessage,
  composePreDetailedAssembly,
  composeRenderingInput,
  composeStructuredTurnText,
  formatTurnRangeHeader,
  wrapEntityXml,
} from "../src/turns/internal/compose.js";

function msg(messageId: string, kind: ComposeMessage["kind"], content: Record<string, unknown>): ComposeMessage {
  return { messageId, kind, blocks: [{ blockType: kind, content }] };
}

describe("wrapEntityXml", () => {
  it("uses the id as the tag name", () => {
    expect(wrapEntityXml("m12", "hello")).toBe("<m12>\nhello\n</m12>");
    expect(wrapEntityXml("t3", "body")).toBe("<t3>\nbody\n</t3>");
  });
});

describe("composeStructuredTurnText labels", () => {
  it("wraps the turn and each non-run message", () => {
    const messages = [msg("m1", "user_prompt", { text: "please read" }), msg("m2", "assistant_text", { text: "done" })];
    const { parts } = composeRenderingInput(messages, new Map());
    // Without ready smoothed_prompt, user_prompt falls back to cleaned text.
    const text = composeStructuredTurnText(parts, "t1");
    expect(text.startsWith("<t1>\n")).toBe(true);
    expect(text.endsWith("\n</t1>")).toBe(true);
    expect(text).toContain("<m1>\n");
    expect(text).toContain("</m1>");
    expect(text).toContain("<m2>\n");
    expect(text).toContain("done");
    expect(text).toContain("User prompt");
    expect(text).toContain("Assistant response\n");
  });

  it("tags each tool-run member line with its own message id", () => {
    const messages = [
      msg("m1", "user_prompt", { text: "go" }),
      msg("m2", "tool_call", {
        toolCallId: "c1",
        toolName: "read",
        arguments: { path: "a.ts" },
      }),
      msg("m3", "tool_result", {
        toolCallId: "c1",
        content: "file body",
        isError: false,
      }),
      msg("m4", "assistant_text", { text: "ok" }),
    ];
    const { parts } = composeRenderingInput(messages, new Map());
    const run = parts.find((part) => part.memberMessageIds !== undefined);
    expect(run).toBeDefined();
    expect(run!.memberMessageIds).toEqual(["m2", "m3"]);
    expect(run!.text).toContain("<m2>");
    expect(run!.text).toContain("</m2>");
    expect(run!.text).toContain("<m3>");
    expect(run!.text).toContain("file body");

    const text = composeStructuredTurnText(parts, "t9");
    expect(text).toContain("<t9>");
    // Run body is not double-wrapped in the lead message id.
    expect(text).not.toMatch(/<m2>\n\[tool run/);
  });
});

describe("pre_detailed_assembly stays untagged", () => {
  it("does not emit message or turn xml", () => {
    const messages = [msg("m1", "user_prompt", { text: "please read" }), msg("m2", "assistant_text", { text: "done" })];
    const assembly = composePreDetailedAssembly(messages, new Map());
    expect(assembly.text).not.toContain("<m");
    expect(assembly.text).not.toContain("<t");
    expect(assembly.text).toContain("User:\n");
    expect(assembly.text).toContain("⏺ ");
  });
});

describe("formatTurnRangeHeader", () => {
  it("lists member turn ids for chunk bands", () => {
    expect(formatTurnRangeHeader(["t1", "t2", "t3"])).toBe("<turns>t1 t2 t3</turns>");
    expect(formatTurnRangeHeader([])).toBe("");
  });
});
