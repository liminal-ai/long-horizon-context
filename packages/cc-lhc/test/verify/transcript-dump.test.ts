import type { SessionThreadView, SessionThreadViewEntry } from "lhc";
import { describe, expect, it } from "vitest";

import { buildRolloutLines } from "../../src/rollout/rebuild.js";
import {
  dumpRolloutLines,
  dumpSessionThreadView,
  parseRolloutContent,
  stableJson,
} from "../../src/verify/transcript-dump.js";

const toolHeavyEntries: SessionThreadViewEntry[] = [
  { role: "user", content: "please list files", sourceMessages: [] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "need ls" },
      { type: "text", text: "Listing now." },
      { type: "toolCall", toolCallId: "toolu_01AB", toolName: "Bash", arguments: { command: "ls", description: "List" } },
    ],
    sourceMessages: [],
  },
  { role: "toolResult", toolCallId: "toolu_01AB", toolName: "Bash", content: "a.ts\nb.ts", sourceMessages: [] },
  {
    role: "assistant",
    content: [{ type: "text", text: "Two files." }],
    sourceMessages: [],
  },
];

describe("stableJson", () => {
  it("sorts keys recursively so structural equality is byte equality", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } })).toBe('{"a":{"c":[{"e":4,"f":3}],"d":2},"b":1}');
  });
});

describe("dumpSessionThreadView", () => {
  it("labels every entry kind deterministically", () => {
    const view: SessionThreadView = {
      threadId: "th",
      entries: [
        ...toolHeavyEntries,
        { kind: "model_change", provider: "anthropic", modelId: "claude-fable-5", sourceMessages: [] },
        { kind: "thinking_level_change", level: "high", sourceMessages: [] },
        { role: "toolResult", toolCallId: "toolu_02", content: "boom", isError: true, sourceMessages: [] },
      ],
    };
    const dump = dumpSessionThreadView(view);
    expect(dump).toContain("[user]\nplease list files");
    expect(dump).toContain("[assistant thinking]\nneed ls");
    expect(dump).toContain('[tool call · Bash · toolu_01AB]\n{"command":"ls","description":"List"}');
    expect(dump).toContain("[tool result · toolu_01AB]\na.ts\nb.ts");
    expect(dump).toContain("[model change · anthropic/claude-fable-5]");
    expect(dump).toContain("[thinking level change · high]");
    expect(dump).toContain("[tool result · toolu_02 · error]\nboom");
  });
});

describe("dumpRolloutLines", () => {
  it("skips meta, sidechain, and non-message lines; normalizes non-string tool_result content", () => {
    const items = parseRolloutContent(
      [
        '{"type":"mode","mode":"normal"}',
        '{"type":"user","isSidechain":true,"message":{"role":"user","content":"sidechain"}}',
        '{"type":"user","isMeta":true,"message":{"role":"user","content":"meta"}}',
        // content-classified meta (no isMeta flag) — the /exit lines from the 230k certification
        '{"type":"user","message":{"role":"user","content":"<command-name>/exit</command-name>"}}',
        '{"type":"user","message":{"role":"user","content":"<local-command-stdout>See ya!</local-command-stdout>"}}',
        // synthetic resume line claude appends when resuming onto a user-final rollout
        '{"type":"assistant","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"No response requested."}]}}',
        '{"type":"user","message":{"role":"user","content":"real prompt"}}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"path":"/x"}}]}}',
        '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"body"}],"is_error":false}]}}',
        "not json",
      ].join("\n"),
    );
    const dump = dumpRolloutLines(items);
    expect(dump).not.toContain("sidechain");
    expect(dump).not.toContain("meta");
    expect(dump).not.toContain("command-name");
    expect(dump).not.toContain("See ya!");
    expect(dump).not.toContain("No response requested.");
    expect(dump).toContain("[user]\nreal prompt");
    expect(dump).toContain('[tool call · Read · t1]\n{"path":"/x"}');
    // array content normalizes through the intake stringification (plain JSON.stringify)
    expect(dump).toContain(`[tool result · t1]\n${JSON.stringify([{ type: "text", text: "body" }])}`);
  });
});

describe("rebuild faithfulness invariant", () => {
  it("a rebuilt rollout dumps identically to the thread view it was built from", () => {
    // The certification core: native re-emission must round-trip — the
    // canonical dump of buildRolloutLines(view) equals the dump of the view
    // itself. Any lossy rendering (bracket labels, dropped ids, flattened
    // blocks) in rebuild breaks this equality.
    const view: SessionThreadView = { threadId: "th", entries: toolHeavyEntries };
    const rebuilt = buildRolloutLines({
      entries: view.entries,
      newSessionId: "sid",
      envelope: { cwd: "/w", assistantModel: "claude-opus-4-6" },
    });
    expect(dumpRolloutLines(rebuilt.map((entry) => entry.line))).toBe(dumpSessionThreadView(view));
  });
});
