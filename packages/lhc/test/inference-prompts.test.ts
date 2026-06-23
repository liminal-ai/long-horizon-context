// Epic 05 Story 3 — TC-2.2 (AC-2.2, AC-2.3): the LHC-owned prompt
// templates. Goldens pin each template's rendered messages for a fixture
// input (prompt/fixture drift is an architecture risk: a model call could
// succeed while a prompt silently loses required input fields); registry
// completeness proves every config-selectable name resolves; the brief/
// detailed contrast and the input-bounding legs run through the adapter
// operations, never the renderers alone (anti-shim).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createInferenceCallbacks } from "../src/shared-tech/inference-adapter.js";
import {
  type ModelCallInput,
  type ResolvedInferenceConfig,
  resolveGuards,
} from "../src/shared-tech/inference-types.js";
import { DEFAULT_PROMPT_NAMES, PROMPT_REGISTRY, type PromptTemplate } from "../src/shared-tech/prompts/index.js";
import { cannedResponses, FAKE_MODEL_PREFIX, recordingCall, validAssignments } from "./fixtures/index.js";

const goldensDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "goldens", "prompts");

// One fixture input per template, keyed by template name. Each carries
// distinctive strings the golden embeds, so a template that drops an input
// field fails its golden rather than passing on shape alone.
const PROMPT_FIXTURES: Record<string, { input: unknown; embedded: string[] }> = {
  "smoothing-v1": {
    input: { text: "plz smooth this prmpt about src/app.ts line 42 thx" },
    embedded: ["src/app.ts line 42"],
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
    embedded: ["contents of notes/plan.md: 3 open items", "succeeded", "120", "content_summary"],
  },
  "lower-band-v1": {
    input: {
      rendering: "The user asked for notes/plan.md; the assistant read it and reported 3 open items.",
    },
    embedded: ["reported 3 open items"],
  },
  "smooth-turn-compression-v1": {
    input: {
      rendering:
        "[1] User prompt (m1)\nPlease inspect notes/plan.md\n\n[2] Assistant response (m2)\nIt has 3 open items.",
      inputTokens: 120,
      targetMinTokens: 42,
      targetAimTokens: 60,
      targetMaxTokens: 78,
    },
    embedded: [
      "notes/plan.md",
      "42-78",
      "Preserve substance",
      "Do not say only that a tool ran or a file was read. Say what it showed, changed, proved, or failed to do.",
      "If it is too short, expand it by restoring missing substance. If it is too long, contract it by removing lower-value detail and repeated explanation.",
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
      text: "[turn 0001]\nUser inspected notes/plan.md and found 3 open items.",
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
};

function renderByName(name: string, input: unknown): ModelCallInput["messages"] {
  const template = PROMPT_REGISTRY[name] as PromptTemplate<unknown> | undefined;
  if (template === undefined) throw new Error(`template "${name}" not in registry`);
  return template.render(input);
}

function resolvedConfig(
  overrides: Partial<ResolvedInferenceConfig> & Pick<ResolvedInferenceConfig, "call">,
): ResolvedInferenceConfig {
  return {
    assignments: validAssignments(),
    guards: resolveGuards(),
    timeoutMs: 60_000,
    maxInputChars: 200_000,
    ...overrides,
  };
}

function userContent(input: ModelCallInput): string {
  const user = input.messages.find((message) => message.role === "user");
  if (user === undefined) throw new Error("no user message in rendered call");
  return user.content;
}

function rawToolResponseExcerpt(input: ModelCallInput): string {
  const user = userContent(input);
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
      const golden = JSON.parse(
        readFileSync(path.join(goldensDir, `${name}.golden.json`), "utf8"),
      ) as ModelCallInput["messages"];
      expect(rendered).toEqual(golden);
    });

    it(`${name} embeds its fixture content in single-turn shape`, () => {
      const fixture = PROMPT_FIXTURES[name];
      const rendered = renderByName(name, fixture?.input);
      expect(rendered.filter((message) => message.role === "user")).toHaveLength(1);
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
    const golden = JSON.parse(
      readFileSync(path.join(goldensDir, "chunk-brief-v2.golden.json"), "utf8"),
    ) as ModelCallInput["messages"];
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
    expect(joined).not.toContain("operationClass");
    expect(joined).not.toContain("responseShape");
    expect(joined).not.toContain("outputChars");
    expect(joined).not.toContain("outputWords");
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
    const bounded = rawToolResponseExcerpt({ provider: "p", model: "m", messages: rendered });
    expect(bounded).toContain("match line 60");
    expect(bounded).not.toContain("match line 61");
    expect(bounded).toContain(
      "[omitted 5 additional search-result lines; use parsed searchMatchCount/searchMatches as authoritative]",
    );
  });
});

describe("TC-2.2: brief receipt-stripping holds through the adapter (AC-2.2)", () => {
  const RECEIPT_ACCOUNT = "read_file fetched notes/plan.md and rewrote temp/out.txt";

  it("the brief rendering receives detailed text and target tokens through the adapter", async () => {
    const { call, log } = recordingCall(cannedResponses());
    const inferenceCallbacks = createInferenceCallbacks(resolvedConfig({ call }));

    const brief = await inferenceCallbacks.summarizeChunkBrief({
      text: `turn one: planning work without ${RECEIPT_ACCOUNT}`,
      inputTokens: 2000,
      targetMinTokens: 160,
      targetAimTokens: 240,
      targetMaxTokens: 400,
    });
    expect(brief.ok).toBe(true);

    const briefCall = log.find((input) => input.model === `${FAKE_MODEL_PREFIX}chunk_summary_brief`);
    expect(briefCall).toBeDefined();
    if (briefCall === undefined) return;

    expect(userContent(briefCall)).toContain("turn one: planning work");
    expect(userContent(briefCall)).toContain("Input size: about 2000 tokens");
    expect(userContent(briefCall)).toContain("Output target: 160–400 tokens");
    expect(userContent(briefCall)).toContain(RECEIPT_ACCOUNT);
  });
});

describe("TC-2.2: tool-result input bounding (AC-2.2, DD-7)", () => {
  const MAX_INPUT_CHARS = 200;

  it("oversized summarizeToolResult input renders head + tail + marker under maxInputChars", async () => {
    const { call, log } = recordingCall(cannedResponses());
    const inferenceCallbacks = createInferenceCallbacks(resolvedConfig({ call, maxInputChars: MAX_INPUT_CHARS }));
    const content = "H".repeat(150) + "M".repeat(700) + "T".repeat(150);
    const result = await inferenceCallbacks.summarizeToolResult({ toolName: "read_file", content });
    expect(result.ok).toBe(true);

    const input = log[0];
    expect(input).toBeDefined();
    if (input === undefined) return;
    const user = userContent(input);
    const bounded = rawToolResponseExcerpt(input);
    expect(bounded.length).toBeLessThanOrEqual(MAX_INPUT_CHARS);
    expect(bounded.startsWith("HHHH")).toBe(true);
    expect(bounded.endsWith("TTTT")).toBe(true);
    expect(bounded).toContain("truncated");
    // Bounding happened before rendering: the middle never reached the prompt.
    expect(user).not.toContain("M".repeat(50));
  });

  it("a maxInputChars below the truncation marker still bounds the whole (DD-7)", async () => {
    const { call, log } = recordingCall(cannedResponses());
    // 40 chars is a legitimately small context budget — and shorter than the
    // truncation marker itself. It is the counterexample to a naive
    // head+tail+marker bound: with no room for the marker, that bound returns
    // the marker alone and overshoots the cap it was meant to hold.
    const tinyMax = 40;
    const inferenceCallbacks = createInferenceCallbacks(resolvedConfig({ call, maxInputChars: tinyMax }));
    const content = "H".repeat(40) + "M".repeat(700) + "T".repeat(40);
    const result = await inferenceCallbacks.summarizeToolResult({ toolName: "read_file", content });
    expect(result.ok).toBe(true);

    const input = log[0];
    expect(input).toBeDefined();
    if (input === undefined) return;
    const user = userContent(input);
    const bounded = rawToolResponseExcerpt(input);
    // The bounded whole never exceeds the cap, even though no marker fits.
    expect(bounded.length).toBeLessThanOrEqual(tinyMax);
    // With no room for the marker the bound degrades to a plain head: a true
    // prefix of the input, never the marker text standing on its own.
    expect(content.startsWith(bounded)).toBe(true);
    expect(bounded).not.toContain("truncated");
    expect(user).not.toContain("M".repeat(50));
  });

  it("under-limit input renders whole, no marker", async () => {
    const { call, log } = recordingCall(cannedResponses());
    const inferenceCallbacks = createInferenceCallbacks(resolvedConfig({ call, maxInputChars: MAX_INPUT_CHARS }));
    const content = "W".repeat(MAX_INPUT_CHARS);
    const result = await inferenceCallbacks.summarizeToolResult({ toolName: "read_file", content });
    expect(result.ok).toBe(true);

    const input = log[0];
    expect(input).toBeDefined();
    if (input === undefined) return;
    const user = userContent(input);
    expect(user).toContain(content);
    expect(user).not.toContain("truncated");
  });
});
