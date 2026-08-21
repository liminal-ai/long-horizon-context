import { describe, expect, it } from "vitest";

import { createInputState } from "../../src/wrapper/modal.js";
import { renderPanel } from "../../src/wrapper/panel.js";

const STATUS_ROWS = [
  "LHC context management",
  "capture ready · retrieval ready",
  "provider context 31k · auto on · trigger 360k · target 180k",
  "Claude native Compact: disabled for this child (DISABLE_AUTO_COMPACT=1) · manual /compact still available",
  "active operation: none",
  "last action: Smart Compact 3m ago (auto) · trigger 508k · view 247k",
  "WARNING: trigger 5.0k is at/below observed Claude host overhead (31k) — every settled turn would compact",
  "edits (auto/bounds) are session-scoped: live now, survive handoffs, lost at wrapper exit",
  "precedence: builtin < user /home/u/.config/cc-lhc/config.json < project /work/.cc-lhc.json < session",
];

function withRows(): ReturnType<typeof createInputState> {
  return { ...createInputState(), mode: "modal", panelRows: STATUS_ROWS };
}

describe("panel status rendering", () => {
  it("renders all status rows at a normal terminal size", () => {
    const out = renderPanel(withRows(), 120, 40);
    for (const row of STATUS_ROWS.filter((r) => r.length <= 118)) {
      expect(out).toContain(row);
    }
    expect(out).toContain("long-horizon commands> ");
  });

  it("renders without corruption at a small terminal size (rows truncated, never wrapped)", () => {
    const out = renderPanel(withRows(), 40, 10);
    // Every emitted text row fits the width budget (truncation with ellipsis).
    const texts = [...out.matchAll(/\x1b\[\d+;\d+H(?:\x1b\[2m)?([^\x1b]+)/g)].map((m) => m[1]!);
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text.length).toBeLessThanOrEqual(38);
    }
    expect(out).toContain("…");
  });

  it("renders at the minimum floor without throwing", () => {
    expect(() => renderPanel(withRows(), 1, 1)).not.toThrow();
  });

  it("clips rows to the terminal height: every cursor row fits, with one explicit continuation row", () => {
    const out = renderPanel(withRows(), 80, 10);
    const cursorRows = [...out.matchAll(/\x1b\[(\d+);\d+H/g)].map((m) => Number.parseInt(m[1]!, 10));
    expect(cursorRows.length).toBeGreaterThan(0);
    for (const row of cursorRows) {
      expect(row).toBeGreaterThanOrEqual(1);
      expect(row).toBeLessThanOrEqual(10);
    }
    expect(out).toContain("… more — enlarge terminal");
    // Prompt and hint always survive clipping.
    expect(out).toContain("long-horizon commands> ");
    expect(out).toContain("Enter run");
  });

  it("keeps prompt and hint within height even at the 5-row floor", () => {
    const out = renderPanel(withRows(), 80, 5);
    const cursorRows = [...out.matchAll(/\x1b\[(\d+);\d+H/g)].map((m) => Number.parseInt(m[1]!, 10));
    for (const row of cursorRows) expect(row).toBeLessThanOrEqual(5);
    expect(out).toContain("long-horizon commands> ");
  });
});
