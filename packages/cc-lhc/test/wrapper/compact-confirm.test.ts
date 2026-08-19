import { describe, expect, it } from "vitest";

import type { OpenAsyncWork } from "../../src/observation/async-work.js";
import { COMPACT_CONFIRM_HINT, compactConfirmRows, describeDecline } from "../../src/wrapper/compact-confirm.js";
import { createInputState, openCompactConfirm, processInputChunk } from "../../src/wrapper/modal.js";
import { renderPanel } from "../../src/wrapper/panel.js";

const NOW = 1_787_135_000_000;

function work(overrides: Partial<OpenAsyncWork> & Pick<OpenAsyncWork, "family">): OpenAsyncWork {
  return { key: overrides.taskId ?? "k", ...overrides } as OpenAsyncWork;
}

describe("what the operator is shown before a swap kills live work", () => {
  it("says nothing when nothing is open", () => {
    expect(compactConfirmRows([], NOW)).toEqual([]);
  });

  it("counts one piece in the singular and more in the plural", () => {
    const one = compactConfirmRows([work({ family: "monitor", taskId: "b1" })], NOW);
    expect(one[0]).toBe("Compact replaces the Claude session and will kill 1 piece of live background work:");
    const two = compactConfirmRows(
      [work({ family: "monitor", taskId: "b1" }), work({ family: "agent", taskId: "a1" })],
      NOW,
    );
    expect(two[0]).toBe("Compact replaces the Claude session and will kill 2 pieces of live background work:");
    expect(two).toHaveLength(3);
  });

  it("names each family in words an operator recognizes", () => {
    const rows = compactConfirmRows(
      [
        work({ family: "agent", taskId: "a1", description: "reviewer" }),
        work({ family: "workflow", taskId: "w1", description: "story-build" }),
        work({ family: "background_shell", taskId: "b1", description: "long build" }),
        work({ family: "monitor", taskId: "m1", description: "CI watch" }),
        work({ family: "scheduled_wakeup", description: "loop tick", scheduledForMs: NOW + 480_000 }),
      ],
      NOW,
    );
    expect(rows.slice(1)).toEqual([
      '  - background agent "reviewer" (a1)',
      '  - workflow "story-build" (w1)',
      '  - background command "long build" (b1)',
      '  - monitor "CI watch" (m1)',
      '  - scheduled wakeup "loop tick" (fires in 8m)',
    ]);
  });

  it("shows the latest progress a monitor reported", () => {
    const rows = compactConfirmRows(
      [work({ family: "monitor", taskId: "m1", description: "CI watch", latestEvent: "TICK-45" })],
      NOW,
    );
    expect(rows[1]).toBe('  - monitor "CI watch" (m1) - last event: TICK-45');
  });

  it("falls back to the id alone when the launch carried no description", () => {
    expect(compactConfirmRows([work({ family: "background_shell", taskId: "b1" })], NOW)[1]).toBe(
      "  - background command (b1)",
    );
  });

  it("counts a wakeup's remaining seconds under a minute", () => {
    const rows = compactConfirmRows([work({ family: "scheduled_wakeup", scheduledForMs: NOW + 42_000 })], NOW);
    expect(rows[1]).toBe("  - scheduled wakeup (fires in 42s)");
  });

  it("keeps every row plain ASCII and single-line", () => {
    const rows = compactConfirmRows(
      [
        work({
          family: "agent",
          taskId: "a1",
          description: "review — the em-dash\nand a newline",
          latestEvent: "progress…",
        }),
      ],
      NOW,
    );
    for (const row of [...rows, COMPACT_CONFIRM_HINT]) {
      expect(row).not.toContain("\n");
      expect(row).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it("bounds a description that would run off the panel", () => {
    const rows = compactConfirmRows([work({ family: "agent", taskId: "a1", description: "x".repeat(200) })], NOW);
    expect(rows[1]!.length).toBeLessThan(100);
    expect(rows[1]).toContain("...");
  });

  it("has a phrase for every way the prompt can end without a yes", () => {
    for (const reason of ["declined", "dismissed", "stdin_closed", "render_failed", "interrupted"] as const) {
      expect(describeDecline(reason)).not.toBe("");
    }
  });
});

describe("the confirmation on the panel", () => {
  const rows = compactConfirmRows([work({ family: "monitor", taskId: "m1", description: "CI watch" })], NOW);

  it("draws the warning, the bullets, and the answer vocabulary", () => {
    const state = openCompactConfirm(createInputState(), rows);
    const drawn = renderPanel(state, 100, 24);
    expect(drawn).toContain("will kill 1 piece of live background work");
    expect(drawn).toContain('monitor "CI watch" (m1)');
    expect(drawn).toContain(COMPACT_CONFIRM_HINT);
    // No editable prompt line: this is a question, not the command panel.
    expect(drawn).not.toContain("long-horizon commands>");
  });

  it("takes y as the only yes", () => {
    for (const key of ["y", "Y"]) {
      const result = processInputChunk(Buffer.from(key), openCompactConfirm(createInputState(), rows));
      expect(result.actions).toEqual([{ kind: "compact_confirm_answered", disposition: { kind: "yes" } }]);
      expect(result.toPty).toHaveLength(0);
      expect(result.state.mode).toBe("passthrough");
    }
  });

  it("treats every other keypress as not now", () => {
    for (const key of ["n", "N", "\r", "\n", "q", " ", "\x7f"]) {
      const result = processInputChunk(Buffer.from(key), openCompactConfirm(createInputState(), rows));
      expect(result.actions, JSON.stringify(key)).toEqual([
        { kind: "compact_confirm_answered", disposition: { kind: "no", reason: "declined" } },
      ]);
      expect(result.toPty).toHaveLength(0);
    }
  });

  it("treats a dismissal as not now", () => {
    for (const key of ["\x1b", "\x03", "\x1d"]) {
      const result = processInputChunk(Buffer.from(key), openCompactConfirm(createInputState(), rows));
      if (key === "\x1b") {
        // A bare Esc is only known to be bare once nothing follows it; the
        // wrapper's short timer settles that, and it settles as a dismissal.
        expect(result.actions).toEqual([]);
        continue;
      }
      expect(result.actions, JSON.stringify(key)).toEqual([
        { kind: "compact_confirm_answered", disposition: { kind: "no", reason: "dismissed" } },
      ]);
    }
  });

  it("ignores terminal noise rather than reading it as an answer", () => {
    // Mouse reports and cursor-position replies arrive unbidden under tmux.
    const noise = Buffer.from("\x1b[<0;10;10M\x1b[24;80R");
    const result = processInputChunk(noise, openCompactConfirm(createInputState(), rows));
    expect(result.actions).toEqual([]);
    expect(result.state.mode).toBe("compact_confirm");
  });

  it("keeps a y typed inside a paste from answering", () => {
    const pasted = Buffer.from("\x1b[200~yes please\x1b[201~");
    const result = processInputChunk(pasted, openCompactConfirm(createInputState(), rows));
    expect(result.actions).toEqual([]);
    expect(result.state.mode).toBe("compact_confirm");
  });

  it("remembers nothing about the answer", () => {
    const answered = processInputChunk(Buffer.from("n"), openCompactConfirm(createInputState(), rows));
    expect(answered.state).toEqual(createInputState());
  });
});
