// Epic 05 Story 3 — TC-2.2 (AC-2.2, AC-2.3): the LHC-owned prompt
// templates. Goldens pin each template's rendered messages for a fixture
// input (prompt/fixture drift is an architecture risk: a provider call could
// succeed while a prompt silently loses required input fields); registry
// completeness proves every config-selectable name resolves; the brief/
// detailed contrast and the input-bounding legs run through the adapter
// operations, never the renderers alone (anti-shim).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createInferenceProvider } from "../src/inference/adapter.js";
import {
  DEFAULT_PROMPT_NAMES,
  PROMPT_REGISTRY,
  type PromptTemplate,
} from "../src/inference/prompts/index.js";
import type { ModelCallInput, ResolvedInferenceConfig } from "../src/inference/types.js";
import {
  cannedResponses,
  FAKE_MODEL_PREFIX,
  DERIVATION_TYPES,
  recordingCall,
  validAssignments,
} from "./fixtures/index.js";

const goldensDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "goldens",
  "prompts",
);

// One fixture input per template, keyed by template name. Each carries
// distinctive strings the golden embeds, so a template that drops an input
// field fails its golden rather than passing on shape alone.
const PROMPT_FIXTURES: Record<string, { input: unknown; embedded: string[] }> = {
  "smoothing-v1": {
    input: { text: "plz smooth this prmpt about src/app.ts line 42 thx" },
    embedded: ["src/app.ts line 42"],
  },
  "tool-result-v1": {
    input: {
      toolName: "read_file",
      content: "contents of notes/plan.md: 3 open items",
      outcome: "succeeded",
      targetTokens: 120,
      guidance: "Preserve paths and counts.",
    },
    embedded: ["contents of notes/plan.md: 3 open items", "succeeded", "120"],
  },
  "turn-compose-v1": {
    input: {
      parts: [
        { messageId: "m1", kind: "user_prompt", text: "please read notes/plan.md", fallback: false },
        {
          messageId: "m2",
          kind: "tool_call",
          text: "read_file called on notes/plan.md",
          fallback: false,
          outcome: "succeeded",
        },
        { messageId: "m3", kind: "assistant_text", text: "the plan has 3 open items", fallback: false },
      ],
    },
    embedded: ["please read notes/plan.md", "outcome: succeeded", "the plan has 3 open items"],
  },
  "lower-band-v1": {
    input: {
      rendering: "The user asked for notes/plan.md; the assistant read it and reported 3 open items.",
    },
    embedded: ["reported 3 open items"],
  },
  "chunk-detailed-v1": {
    input: {
      memberProjections: ["turn one: read notes/plan.md", "turn two: edited src/app.ts"],
      memberReceipts: [
        [
          {
            messageId: "m2",
            activity: "tool_call",
            account: "read_file fetched notes/plan.md",
            outcome: "succeeded",
          },
        ],
        [],
      ],
    },
    embedded: ["turn one: read notes/plan.md", "read_file fetched notes/plan.md => succeeded"],
  },
  "chunk-brief-v1": {
    input: {
      memberProjections: ["turn one: read notes/plan.md", "turn two: edited src/app.ts"],
      memberOutcomes: [["succeeded"], []],
    },
    embedded: ["turn two: edited src/app.ts", "Tool outcomes, in order: succeeded"],
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

describe("TC-2.2: prompt-rendering goldens (AC-2.2, AC-2.3)", () => {
  for (const kind of DERIVATION_TYPES) {
    const name = DEFAULT_PROMPT_NAMES[kind];
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
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const name of names) {
      expect(PROMPT_REGISTRY[name]?.name).toBe(name);
      expect(typeof PROMPT_REGISTRY[name]?.render).toBe("function");
    }
  });

  it("default names cover all derivation kinds and each resolves in the registry", () => {
    const defaultNames = new Set<string>();
    for (const kind of DERIVATION_TYPES) {
      const name = DEFAULT_PROMPT_NAMES[kind];
      expect(typeof name).toBe("string");
      expect(PROMPT_REGISTRY[name]).toBeDefined();
      defaultNames.add(name);
    }
    // One distinct template per derivation kind — no kind shares another's prompt.
    expect(defaultNames.size).toBe(DERIVATION_TYPES.length);
  });
});

describe("TC-2.2: brief receipt-stripping holds through the adapter (AC-2.2)", () => {
  const RECEIPT_ACCOUNT = "read_file fetched notes/plan.md and rewrote temp/out.txt";

  it("the brief rendering carries outcome tokens but no receipt text from its input", async () => {
    const { call, log } = recordingCall(cannedResponses());
    const provider = createInferenceProvider(resolvedConfig({ call }));

    const detailed = await provider.summarizeChunkDetailed({
      memberProjections: ["turn one: planning work"],
      memberReceipts: [
        [{ messageId: "m2", activity: "tool_call", account: RECEIPT_ACCOUNT, outcome: "succeeded" }],
      ],
    });
    const brief = await provider.summarizeChunkBrief({
      memberProjections: ["turn one: planning work"],
      memberOutcomes: [["succeeded"]],
    });
    expect(detailed.ok).toBe(true);
    expect(brief.ok).toBe(true);

    const detailedCall = log.find(
      (input) => input.model === `${FAKE_MODEL_PREFIX}chunk_summary_detailed`,
    );
    const briefCall = log.find(
      (input) => input.model === `${FAKE_MODEL_PREFIX}chunk_summary_brief`,
    );
    expect(detailedCall).toBeDefined();
    expect(briefCall).toBeDefined();
    if (detailedCall === undefined || briefCall === undefined) return;

    // The detailed lane is the contrast: its rendering carries the receipt
    // account verbatim, so its absence from the brief lane is stripping, not
    // a template that ignores receipts altogether.
    expect(userContent(detailedCall)).toContain(RECEIPT_ACCOUNT);
    expect(userContent(briefCall)).toContain("succeeded");
    expect(userContent(briefCall)).not.toContain(RECEIPT_ACCOUNT);
    expect(userContent(briefCall)).not.toContain("rewrote");
  });
});

describe("TC-2.2: tool-result input bounding (AC-2.2, DD-7)", () => {
  const MAX_INPUT_CHARS = 200;

  it("oversized summarizeToolResult input renders head + tail + marker under maxInputChars", async () => {
    const { call, log } = recordingCall(cannedResponses());
    const provider = createInferenceProvider(
      resolvedConfig({ call, maxInputChars: MAX_INPUT_CHARS }),
    );
    const content = "H".repeat(150) + "M".repeat(700) + "T".repeat(150);
    const result = await provider.summarizeToolResult({ toolName: "read_file", content });
    expect(result.ok).toBe(true);

    const input = log[0];
    expect(input).toBeDefined();
    if (input === undefined) return;
    const user = userContent(input);
    const bounded = user.slice(user.indexOf("Output:\n") + "Output:\n".length);
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
    const provider = createInferenceProvider(
      resolvedConfig({ call, maxInputChars: tinyMax }),
    );
    const content = "H".repeat(40) + "M".repeat(700) + "T".repeat(40);
    const result = await provider.summarizeToolResult({ toolName: "read_file", content });
    expect(result.ok).toBe(true);

    const input = log[0];
    expect(input).toBeDefined();
    if (input === undefined) return;
    const user = userContent(input);
    const bounded = user.slice(user.indexOf("Output:\n") + "Output:\n".length);
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
    const provider = createInferenceProvider(
      resolvedConfig({ call, maxInputChars: MAX_INPUT_CHARS }),
    );
    const content = "W".repeat(MAX_INPUT_CHARS);
    const result = await provider.summarizeToolResult({ toolName: "read_file", content });
    expect(result.ok).toBe(true);

    const input = log[0];
    expect(input).toBeDefined();
    if (input === undefined) return;
    const user = userContent(input);
    expect(user).toContain(content);
    expect(user).not.toContain("truncated");
  });
});
