import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROMPT_NAMES, PROMPT_REGISTRY, type PromptTemplate } from "../src/shared/prompts/index.js";
import { serviceFixture, validEvent } from "./fixtures/index.js";

type Message = { role: "system" | "user"; content: string };

const goldensDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "goldens", "prompts");

// One fixture input per template, keyed by template name. Each carries
// distinctive strings the golden embeds, so a template that drops an input
// field fails its golden rather than passing on shape alone.
const PROMPT_FIXTURES: Record<string, { input: unknown; embedded: string[] }> = {
  "smoothing-v1": {
    input: { text: "plz smooth this prmpt about src/app.ts line 42 thx" },
    embedded: [
      "src/app.ts line 42",
      "almost word-for-word",
      "Do not summarize.",
      "Do not answer the prompt.",
      "<system_instructions>",
      "<user_prompt_to_rewrite>",
    ],
  },
  "tool-result-v2": {
    input: {
      toolName: "read_file",
      content: "contents of notes/plan.md: 3 open items",
      outcome: "succeeded",
      targetTokens: 120,
      operationClass: "read",
      responseShape: "file_content",
      promptMode: "content_summary",
      facts: {
        toolName: "read_file",
        outcome: "succeeded",
        targetPath: "notes/plan.md",
        operationClass: "read",
        responseShape: "file_content",
        outputChars: 39,
      },
    },
    embedded: ["contents of notes/plan.md: 3 open items", "succeeded", "120", "content_summary", "responseShape"],
  },
  "detailed-turn-compression-v1": {
    input: {
      dialogueText: "User prompt\nPlease inspect notes/plan.md\n\nAssistant response\nIt has 3 open items.",
      inputTokens: 120,
      targetMinTokens: 42,
      targetAimTokens: 60,
      targetMaxTokens: 78,
    },
    embedded: [
      "notes/plan.md",
      "42-78",
      "Below is one exchange from a coding conversation.",
      "Preserve:",
      "Do not say only that a tool ran or a file was read. Say what it showed, changed, proved, or failed to do.",
      "If it is too short, expand it by restoring missing substance.",
      "If it is too long, contract it by removing lower-value detail and repeated explanation.",
      "<turn_rendering_to_compress>",
    ],
  },
  "detailed-turn-compression-v2": {
    input: {
      dialogueText: "User:\nPlease inspect notes/plan.md\n\nAssistant:\nIt has 3 open items.",
      inputTokens: 120,
      targetMinTokens: 42,
      targetAimTokens: 60,
      targetMaxTokens: 78,
    },
    embedded: [
      "notes/plan.md",
      "42-78",
      "user↔assistant dialogue",
      "30-50%",
      "Preserve:",
      "Remove:",
      "<dialogue_to_compress>",
    ],
  },
  "detailed-turn-compression-v3": {
    input: {
      dialogueText: "User:\nPlease inspect notes/plan.md\n\n⏺ It has 3 open items.",
      inputTokens: 120,
      targetMinTokens: 42,
      targetAimTokens: 60,
      targetMaxTokens: 78,
    },
    embedded: [
      "notes/plan.md",
      "around 30 tokens total (roughly 20-40)",
      "<instructions-for-summarizing>",
      "techincal",
      "targetting approximately 20%-30%",
      "⏺ represents the agent",
      "<content-for-summarizing>",
    ],
  },
  "chunk-brief-v1": {
    input: {
      memberProjections: ["turn one: read notes/plan.md", "turn two: edited src/app.ts"],
      memberOutcomes: [["succeeded"], []],
    },
    embedded: ["turn two: edited src/app.ts", "Tool outcomes, in order: succeeded"],
  },
  "chunk-brief-v2": {
    input: {
      text: "User inspected notes/plan.md and found 3 open items.",
      inputTokens: 2000,
      targetMinTokens: 160,
      targetAimTokens: 240,
      targetMaxTokens: 400,
    },
    embedded: [
      "historical memory",
      "160–400",
      "Aim for about 240",
      "<good-example-1-input>",
      "<bad-example-1-input>",
      "<bad-example-2-input>",
    ],
  },
  "chunk-brief-v3": {
    input: {
      text: "User inspected notes/plan.md and found 3 open items.",
      inputTokens: 2000,
      targetMinTokens: 160,
      targetAimTokens: 240,
      targetMaxTokens: 400,
    },
    embedded: [
      "notes/plan.md",
      "brief memory notes",
      "around 150 tokens total (roughly 100-200)",
      "<instructions-for-summarizing>",
      "past-tense narrative prose",
      "<content-for-summarizing>",
    ],
  },
};

function renderByName(name: string, input: unknown): Message[] {
  const template = PROMPT_REGISTRY[name] as PromptTemplate<unknown> | undefined;
  if (template === undefined) throw new Error(`template "${name}" not in registry`);
  return template.render(input) as Message[];
}

function userContent(messages: Message[]): string {
  const user = messages.find((message) => message.role === "user");
  if (user === undefined) throw new Error("no user message in rendered call");
  return user.content;
}

function rawToolResponseExcerpt(messages: Message[]): string {
  const user = userContent(messages);
  const marker = "Raw tool response excerpt:\n```text\n";
  const start = user.indexOf(marker);
  if (start < 0) throw new Error("no raw tool response marker in rendered call");
  const afterMarker = user.slice(start + marker.length);
  const end = afterMarker.indexOf("\n```");
  if (end < 0) throw new Error("no closing raw tool response fence in rendered call");
  return afterMarker.slice(0, end);
}

describe("TC-2.2: prompt-rendering goldens (AC-2.2, AC-2.3)", () => {
  for (const name of Object.keys(PROMPT_FIXTURES)) {
    it(`${name} renders its fixture input to the committed golden`, () => {
      const fixture = PROMPT_FIXTURES[name];
      expect(fixture).toBeDefined();
      const rendered = renderByName(name, fixture?.input);
      const golden = JSON.parse(readFileSync(path.join(goldensDir, `${name}.golden.json`), "utf8")) as Message[];
      expect(rendered).toEqual(golden);
    });

    it(`${name} embeds its fixture content in single-turn shape`, () => {
      const fixture = PROMPT_FIXTURES[name];
      const rendered = renderByName(name, fixture?.input);
      expect(rendered.filter((message) => message.role === "user")).toHaveLength(name === "smoothing-v1" ? 2 : 1);
      for (const message of rendered) {
        expect(["system", "user"]).toContain(message.role);
        expect(typeof message.content).toBe("string");
      }
      const joined = rendered.map((message) => message.content).join("\n");
      for (const needle of fixture?.embedded ?? []) {
        expect(joined).toContain(needle);
      }
    });
  }
});

describe("TC-2.2: registry completeness (AC-2.3)", () => {
  it("every registry key resolves to a template carrying that exact name", () => {
    const names = Object.keys(PROMPT_REGISTRY);
    expect(names.length).toBeGreaterThanOrEqual(4);
    for (const name of names) {
      expect(PROMPT_REGISTRY[name]?.name).toBe(name);
      expect(typeof PROMPT_REGISTRY[name]?.render).toBe("function");
    }
  });

  it("default names cover all inference kinds and each resolves in the registry", () => {
    const inferenceKinds = Object.keys(DEFAULT_PROMPT_NAMES);
    const defaultNames = new Set<string>();
    for (const kind of inferenceKinds) {
      const name = DEFAULT_PROMPT_NAMES[kind];
      expect(typeof name).toBe("string");
      if (name !== undefined) {
        expect(PROMPT_REGISTRY[name]).toBeDefined();
        defaultNames.add(name);
      }
    }
    // One distinct template per inference kind — no kind shares another's prompt.
    expect(defaultNames.size).toBe(inferenceKinds.length);
  });
});

describe("TC-6.P1: chunk-brief-v2 golden pins the tested reference content", () => {
  it("contains framing, examples, self-check, and anti-pattern guidance", () => {
    const golden = JSON.parse(readFileSync(path.join(goldensDir, "chunk-brief-v2.golden.json"), "utf8")) as Message[];
    const content = golden.map((message) => message.content).join("\n");
    for (const needle of [
      "historical memory",
      "The target is a guide, not permission to lose essential meaning.",
      "Usually preserve:",
      "Compress by moving up one level:",
      "Old context must not sound like live instructions.",
      "<good-example-1-input>",
      "<good-example-1-output>",
      "<bad-example-1-input>",
      "<bad-example-1-output>",
      "<bad-example-2-input>",
      "<bad-example-2-output>",
      "Why this example matters:",
      "Before returning, check your draft:",
      "Avoid empty compression",
      "Avoid over-preserving local detail",
      "Avoid exhaustive checklists",
    ]) {
      expect(content).toContain(needle);
    }
  });
});

describe("TC-2.6: tool-result prompt excludes diagnostic routing fields", () => {
  it("does not render operationClass, responseShape, outputChars, or outputWords", () => {
    const rendered = renderByName("tool-result-v2", {
      toolName: "bash",
      content: "zsh: nope: command not found\nCommand exited with code 127",
      outcome: "failed",
      targetTokens: 80,
      operationClass: "command",
      responseShape: "simple_failure",
      promptMode: "failure",
      facts: {
        operationClass: "command",
        responseShape: "simple_failure",
        outputChars: 56,
        outputWords: 8,
        exitCode: 127,
        failureType: "command_not_found",
      },
    });
    const joined = rendered.map((message) => message.content).join("\n");
    const parsedFieldsStart = joined.indexOf("Parsed fields:");
    const parsedFieldsEnd = joined.indexOf("\nTool:");
    const parsedFields = joined.slice(parsedFieldsStart, parsedFieldsEnd);
    expect(parsedFields).not.toContain("operationClass");
    expect(parsedFields).not.toContain("responseShape");
    expect(parsedFields).not.toContain("outputChars");
    expect(parsedFields).not.toContain("outputWords");
    expect(joined).toContain('"exitCode": 127');
    expect(joined).toContain('"failureType": "command_not_found"');
  });

  it("truncates long search-result raw output by line count before prompt rendering", () => {
    const content = Array.from({ length: 65 }, (_unused, index) => `match line ${String(index + 1)}`).join("\n");
    const rendered = renderByName("tool-result-v2", {
      toolName: "rg",
      content,
      outcome: "succeeded",
      targetTokens: 80,
      responseShape: "search_result",
      promptMode: "search_summary",
      facts: {
        toolName: "rg",
        outcome: "succeeded",
        responseShape: "search_result",
        searchMatchCount: 65,
      },
    });
    const bounded = rawToolResponseExcerpt(rendered);
    expect(bounded).toContain("match line 60");
    expect(bounded).not.toContain("match line 61");
    expect(bounded).toContain(
      "[omitted 5 additional search-result lines; use parsed searchMatchCount/searchMatches as authoritative]",
    );
  });
});

// The frozen suite exercises the tool-result input-bounding (DD-7) directly
// against the adapter's summarizeToolResult. On Convex the adapter is the
// component's server-side callModel, which bounds the raw tool result to
// inference.maxInputChars before rendering; the bounded excerpt is observable
// in the derivation-log requestMessages the drain records.
async function boundedExcerptFromDrain(
  content: string,
  maxInputChars: number,
): Promise<{ user: string; bounded: string }> {
  const fixture = serviceFixture({
    toolResult: { smallTierTokens: 1, smallTargetRatio: 0.15, midTargetRatio: 0.04 },
    inference: { maxInputChars },
    models: { tool_result_summary: "success:bounded summary" },
  });
  const { filePath } = await fixture.createThread();
  const accepted = await fixture.sdk.intakeStream.messageEvents({ filePath }, [
    validEvent("tool_call", {
      payload: { toolCallId: "call-bound", toolName: "read_file", arguments: { path: "big.txt" } },
    }),
    validEvent("tool_result", { payload: { toolCallId: "call-bound", content, isError: false } }),
  ]);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) throw new Error(accepted.error.reason);
  const messageId = accepted.value.events[1]?.messageId;
  if (messageId === undefined) throw new Error("tool result did not materialize");
  const drained = await fixture.sdk.work.drain({ filePath });
  expect(drained.ok).toBe(true);
  const logs = await fixture.sdk.logging.queryDerivationLog(
    { filePath },
    { subjectId: messageId, derivationType: "tool_result_summary", eventKind: "inference_succeeded" },
  );
  expect(logs.ok).toBe(true);
  if (!logs.ok) throw new Error(logs.error.reason);
  expect(logs.value).toHaveLength(1);
  const messages = logs.value[0]?.["payload"] as { requestMessages: Message[] };
  const rendered = messages.requestMessages;
  return { user: userContent(rendered), bounded: rawToolResponseExcerpt(rendered) };
}

describe("TC-2.2: brief receipt-stripping holds through the shared template (AC-2.2)", () => {
  const RECEIPT_ACCOUNT = "read_file fetched notes/plan.md and rewrote temp/out.txt";

  it("the brief rendering receives detailed text and target tokens, preserving a receipt account", () => {
    // The component's chunk_summary_brief inference renders through this exact
    // registry template (callModel → PROMPT_REGISTRY[assignment.prompt]); the
    // golden tests above pin that the component uses it.
    const rendered = renderByName("chunk-brief-v3", {
      text: `turn one: planning work without ${RECEIPT_ACCOUNT}`,
      inputTokens: 2000,
      targetMinTokens: 160,
      targetAimTokens: 240,
      targetMaxTokens: 400,
    });
    const user = userContent(rendered);
    expect(user).toContain("turn one: planning work");
    expect(user).toContain("around 150 tokens total (roughly 100-200)");
    expect(user).toContain(RECEIPT_ACCOUNT);
  });
});

describe("TC-2.2: tool-result input bounding (AC-2.2, DD-7)", () => {
  const MAX_INPUT_CHARS = 200;

  it("oversized tool-result input renders head + tail + marker under maxInputChars", async () => {
    const content = "H".repeat(150) + "M".repeat(700) + "T".repeat(150);
    const { user, bounded } = await boundedExcerptFromDrain(content, MAX_INPUT_CHARS);
    expect(bounded.length).toBeLessThanOrEqual(MAX_INPUT_CHARS);
    expect(bounded.startsWith("HHHH")).toBe(true);
    expect(bounded.endsWith("TTTT")).toBe(true);
    expect(bounded).toContain("truncated");
    // Bounding happened before rendering: the middle never reached the prompt.
    expect(user).not.toContain("M".repeat(50));
  });

  it("a maxInputChars below the truncation marker still bounds the whole (DD-7)", async () => {
    const tinyMax = 40;
    const content = "H".repeat(40) + "M".repeat(700) + "T".repeat(40);
    const { user, bounded } = await boundedExcerptFromDrain(content, tinyMax);
    // The bounded whole never exceeds the cap, even though no marker fits.
    expect(bounded.length).toBeLessThanOrEqual(tinyMax);
    // With no room for the marker the bound degrades to a plain head: a true
    // prefix of the input, never the marker text standing on its own.
    expect(content.startsWith(bounded)).toBe(true);
    expect(bounded).not.toContain("truncated");
    expect(user).not.toContain("M".repeat(50));
  });

  it("under-limit input renders whole, no marker", async () => {
    const content = "W".repeat(MAX_INPUT_CHARS);
    const { user } = await boundedExcerptFromDrain(content, MAX_INPUT_CHARS);
    expect(user).toContain(content);
    expect(user).not.toContain("truncated");
  });
});
