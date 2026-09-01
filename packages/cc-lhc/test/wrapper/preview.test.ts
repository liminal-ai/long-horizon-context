/**
 * D12 preview harness: the nine named first-load fixtures drawn by the
 * production renderer at normal, narrow, and 20x5 geometry in a disposable
 * home; Escape and the reopen key through the production input machine; no
 * Claude launch anywhere in the module graph.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ccLhcHome } from "../../src/intake/paths.js";
import { ACTIONABLE_KINDS, firstLoadMarkerPath, readShownVersion } from "../../src/wrapper/first-load.js";
import { DEFAULT_LEADER_BYTE } from "../../src/wrapper/modal.js";
import { PANEL_TITLE } from "../../src/wrapper/panel-commands.js";
import {
  createPreviewHome,
  frameGrid,
  isPreviewArgv,
  PREVIEW_FIXTURE_NAMES,
  PREVIEW_FIXTURES,
  PREVIEW_GEOMETRIES,
  PREVIEW_GEOMETRY_NAMES,
  type PreviewRender,
  renderPreview,
  renderPreviewMatrix,
  runPreviewCli,
} from "../../src/wrapper/preview.js";
import { panelText, stripAnsi } from "../helpers/panel-text.js";

const STYLE = { color: false, attributes: false };
const here = dirname(fileURLToPath(import.meta.url));

function textOf(render: PreviewRender): string {
  return panelText(render.frame);
}

describe("D12 preview fixtures and geometry matrix", () => {
  let matrix: PreviewRender[] = [];
  const disposable: string[] = [];

  afterEach(() => {
    for (const dir of disposable.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function all(): PreviewRender[] {
    if (matrix.length === 0) matrix = renderPreviewMatrix({ style: STYLE });
    return matrix;
  }

  it("provides exactly the nine named fixtures and three geometries; every fixture renders at every geometry", () => {
    expect([...PREVIEW_FIXTURE_NAMES]).toEqual([
      "normal-first-launch",
      "native-auto-compact-conflict",
      "200k-fallback",
      "capture-database-unsafe",
      "replacement-failure",
      "possible-undelivered-input",
      "unmanageable-async-identity",
      "multiple-prioritized-messages",
      "no-messages",
    ]);
    expect(PREVIEW_GEOMETRIES).toEqual({
      normal: { cols: 100, rows: 30 },
      narrow: { cols: 44, rows: 20 },
      tiny: { cols: 20, rows: 5 },
    });
    const renders = all();
    expect(renders).toHaveLength(27);
    const seen = new Set(renders.map((r) => `${r.fixture}@${r.geometry}`));
    for (const f of PREVIEW_FIXTURE_NAMES)
      for (const g of PREVIEW_GEOMETRY_NAMES) expect(seen.has(`${f}@${g}`)).toBe(true);
    expect(renders.filter((r) => r.geometry === "normal").every((r) => r.tier === "full")).toBe(true);
    expect(renders.filter((r) => r.geometry === "narrow").every((r) => r.tier === "compact")).toBe(true);
    expect(renders.filter((r) => r.geometry === "tiny").every((r) => r.tier === "survival")).toBe(true);
  });

  it("Escape closes and the reopen key returns the identical panel for every fixture at every geometry", () => {
    for (const render of all()) {
      expect(render.escapeClosed, `${render.fixture}@${render.geometry} escape`).toBe(true);
      expect(render.reopenReturned, `${render.fixture}@${render.geometry} reopen`).toBe(true);
    }
  });

  it("each fixture carries exactly its messages, in priority order, with the same rows at every geometry", () => {
    const rowsOf = (name: string): string[][] =>
      PREVIEW_GEOMETRY_NAMES.map((g) => all().find((r) => r.fixture === name && r.geometry === g)!.panelRows);
    for (const name of PREVIEW_FIXTURE_NAMES) {
      const [normal, narrow, tiny] = rowsOf(name);
      expect(narrow, name).toEqual(normal);
      expect(tiny, name).toEqual(normal);
    }
    const headers = (name: string): string[] => rowsOf(name)[0]!.filter((row) => row.startsWith("! "));
    expect(headers("no-messages")).toEqual([]);
    expect(headers("200k-fallback")).toEqual([]);
    expect(headers("normal-first-launch")).toEqual([]);
    expect(rowsOf("normal-first-launch")[0]![0]).toContain("Welcome to CC-LHC");
    expect(headers("native-auto-compact-conflict")).toEqual([
      "! Claude native auto-compact may run before Smart Compact on this launch",
    ]);
    expect(headers("capture-database-unsafe")).toEqual([
      "! cc-lhc state is unsafe — capture or the database could not be trusted",
    ]);
    expect(headers("replacement-failure")).toEqual([
      "! Smart Compact replacements keep failing — the automatic child swap is stopped",
    ]);
    expect(headers("possible-undelivered-input")).toEqual([
      "! input may not have reached Claude — resend what you typed",
    ]);
    expect(headers("unmanageable-async-identity")).toEqual([
      "! background work could not be identified — its records were not carried",
    ]);
    // Five conditions handed over out of order come back in allowlist priority, onboarding last.
    const multi = rowsOf("multiple-prioritized-messages")[0]!;
    expect(headers("multiple-prioritized-messages")).toEqual([
      "! input may not have reached Claude — resend what you typed",
      "! cc-lhc state is unsafe — capture or the database could not be trusted",
      "! Smart Compact replacements keep failing — the automatic child swap is stopped",
      "! background work could not be identified — its records were not carried",
      "! Claude native auto-compact may run before Smart Compact on this launch",
    ]);
    expect(multi.indexOf(multi.find((r) => r.startsWith("Welcome to CC-LHC"))!)).toBeGreaterThan(
      multi.lastIndexOf(multi.filter((r) => r.startsWith("! ")).at(-1)!),
    );
    // Only the launches the contract auto-opens do so.
    const auto = new Set(
      all()
        .filter((r) => r.geometry === "normal" && r.autoOpened)
        .map((r) => r.fixture),
    );
    expect([...auto].sort()).toEqual(
      [
        "normal-first-launch",
        "native-auto-compact-conflict",
        "capture-database-unsafe",
        "replacement-failure",
        "possible-undelivered-input",
        "unmanageable-async-identity",
        "multiple-prioritized-messages",
      ].sort(),
    );
    expect(ACTIONABLE_KINDS).toHaveLength(5);
  });

  it("clipping and spacing: nothing escapes the terminal box, the title/hint survive at 20x5, the card frame stays intact where drawn", () => {
    for (const render of all()) {
      const label = `${render.fixture}@${render.geometry}`;
      const grid = frameGrid(render.frame, render.cols, render.rows);
      expect(grid, label).toHaveLength(render.rows);
      for (const line of grid) expect(line.length, `${label}: ${line}`).toBeLessThanOrEqual(render.cols);
      // No drawn text lands outside the grid: re-laying the frame on a larger
      // canvas adds nothing beyond the declared box.
      const wider = frameGrid(render.frame, render.cols + 40, render.rows + 10);
      expect(
        wider.slice(render.rows).every((line) => line === ""),
        `${label}: rows below the box`,
      ).toBe(true);
      expect(
        wider.every((line) => line.length <= render.cols),
        `${label}: columns right of the box`,
      ).toBe(true);
      const text = textOf(render);
      if (render.tier !== "survival") {
        expect(text, label).toContain(PANEL_TITLE.startsWith("Long") ? "Long Horizon Context" : PANEL_TITLE);
        const framed = grid.filter((line) => line.trimStart().startsWith("│"));
        expect(
          framed.every((line) => line.trimEnd().endsWith("│")),
          `${label}: card frame`,
        ).toBe(true);
      }
      // Every drawn row ends inside the hint: the exit hint is the last drawn row.
      const drawn = grid.filter((line) => line !== "");
      expect(drawn.at(-1) ?? "", `${label}: hint row`).toMatch(/esc|close|ctrl-|leader|Esc/i);
      // No blank row runs: at most one empty row between drawn rows inside the card.
      let blanks = 0;
      for (const line of grid.slice(
        grid.findIndex((l) => l !== ""),
        grid.length -
          grid
            .slice()
            .reverse()
            .findIndex((l) => l !== ""),
      )) {
        blanks = line === "" ? blanks + 1 : 0;
        expect(blanks, `${label}: consecutive blank rows`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("normal geometry shows every message row of every fixture in full; narrow keeps the headers in order; 20x5 keeps the first message", () => {
    for (const render of all()) {
      const text = textOf(render);
      const headers = render.panelRows.filter((row) => row.startsWith("! "));
      if (render.geometry === "normal") {
        // Every row in full — or, for a body taller than the card, the head in
        // order with the clip marker where the rest fell off.
        const clipped = text.includes("… more — enlarge terminal");
        let cursor = -1;
        for (const row of render.panelRows) {
          const at = text.indexOf(row, cursor + 1);
          if (at < 0) {
            expect(clipped, `${render.fixture}: ${row} missing without a clip marker`).toBe(true);
            break;
          }
          cursor = at;
        }
        if (clipped) expect(render.fixture).toBe("multiple-prioritized-messages");
      }
      if (render.geometry === "narrow") {
        // Headers wrap at this width and later ones may be clipped, but the
        // first is always on screen and the visible ones keep priority order.
        let cursor = -1;
        headers.forEach((header, index) => {
          const lead = new RegExp(header.slice(2).split(" ").slice(0, 3).join(String.raw`\s+`));
          const at = text.slice(cursor + 1).search(lead);
          if (index === 0) expect(at, `${render.fixture} narrow: ${header}`).toBeGreaterThanOrEqual(0);
          if (at >= 0) cursor = cursor + 1 + at;
        });
        if (render.panelRows.length > 0 && headers.length === 0) {
          expect(text, `${render.fixture} narrow: onboarding head`).toContain("Welcome to CC-LHC");
        }
      }
      if (render.geometry === "tiny") {
        // 20x5 keeps one guidance row: the first header, or the onboarding welcome.
        const first = (headers[0] ?? render.panelRows[0])?.replace(/^! /, "");
        if (first !== undefined)
          expect(stripAnsi(render.frame), `${render.fixture} tiny`).toContain(first.slice(0, 10));
      }
    }
  });

  it("uses a disposable home and database only, and never a real operator location", () => {
    const home = createPreviewHome();
    disposable.push(home.path);
    expect(home.path.startsWith(tmpdir())).toBe(true);
    expect(existsSync(join(home.path, "cc-lhc.sqlite"))).toBe(true);
    expect(readShownVersion(firstLoadMarkerPath(home.path))).toBeNull();
    const render = renderPreview(PREVIEW_FIXTURES["normal-first-launch"], "normal", home, { style: STYLE });
    expect(textOf(render)).toContain("Welcome to CC-LHC");
    // The fixture's marker state is written into the disposable home, nowhere else.
    expect(readShownVersion(firstLoadMarkerPath(home.path))).toBeNull();
    renderPreview(PREVIEW_FIXTURES["no-messages"], "normal", home, { style: STYLE });
    expect(readShownVersion(firstLoadMarkerPath(home.path))).toBe(1);
    const files = readdirSync(home.path)
      .filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm"))
      .sort();
    expect(files).toEqual(["cc-lhc.sqlite", "first-load.json"]);
    // Never the operator's home: the disposable root is a fresh temp directory.
    expect(home.path).not.toBe(ccLhcHome());
    expect(ccLhcHome().startsWith(home.path)).toBe(false);
    home.dispose();
    expect(existsSync(home.path)).toBe(false);
  });

  it("never launches Claude: the module graph has no wrapper run, PTY, or child-process import", () => {
    const source = readFileSync(join(here, "../../src/wrapper/preview.ts"), "utf8");
    for (const forbidden of ["./run.js", "node-pty", "node:child_process", "spawn", "CC_LHC_CLAUDE_BIN"]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    const imports = [...source.matchAll(/from "(\.[^"]+)"/g)].map((m) => m[1]!);
    expect(imports.some((p) => p.endsWith("/run.js") || p.endsWith("intake/session.js"))).toBe(false);
  });

  it("the configured reopen key is honored: a non-default leader opens, Escape closes, the same leader reopens", () => {
    const home = createPreviewHome();
    disposable.push(home.path);
    const render = renderPreview(PREVIEW_FIXTURES["possible-undelivered-input"], "normal", home, {
      style: STYLE,
      leaderByte: 0x01,
    });
    expect(render.escapeClosed).toBe(true);
    expect(render.reopenReturned).toBe(true);
    // The onboarding names the configured key, not the default.
    const onboarding = renderPreview(PREVIEW_FIXTURES["normal-first-launch"], "normal", home, {
      style: STYLE,
      leaderByte: 0x01,
    });
    expect(onboarding.panelRows.join("\n")).toContain("reopen this panel any time with ctrl-a");
    expect(onboarding.panelRows.join("\n")).not.toContain("ctrl-]");
    expect(DEFAULT_LEADER_BYTE).toBe(0x1d);
    home.dispose();
  });
});

describe("cc-lhc preview CLI", () => {
  function cli(argv: string[], env: NodeJS.ProcessEnv = { TERM: "dumb" }): { code: number; out: string; err: string } {
    let out = "";
    let err = "";
    const code = runPreviewCli(argv, {
      stdout: (t) => {
        out += t;
      },
      stderr: (t) => {
        err += t;
      },
      env,
    });
    return { code, out, err };
  }

  it("is selected by the first argument only", () => {
    expect(isPreviewArgv(["preview"])).toBe(true);
    expect(isPreviewArgv(["preview", "--raw"])).toBe(true);
    expect(isPreviewArgv(["--resume", "preview"])).toBe(false);
    expect(isPreviewArgv([])).toBe(false);
  });

  it("draws the full matrix as plain grids with the interaction verdicts", () => {
    const { code, out, err } = cli(["preview"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    const headers = out.split("\n").filter((line) => line.startsWith("## "));
    expect(headers).toHaveLength(27);
    for (const line of headers) {
      expect(line).toMatch(/ — (opens at launch|on demand only) · Esc closes · ctrl-\] reopens$/);
    }
    expect(out).toContain("## normal-first-launch @ normal (100x30, full) — opens at launch");
    expect(out).toContain("## no-messages @ tiny (20x5, survival) — on demand only");
    expect(out).not.toMatch(new RegExp(`${String.fromCharCode(0x1b)}\\[`));
  });

  it("selects one fixture and geometry, prints the exact frame with --raw, and rejects misuse with exit 2", () => {
    const one = cli(["preview", "--fixture", "replacement-failure", "--geometry", "narrow"]);
    expect(one.code).toBe(0);
    expect(one.out.split("\n").filter((l) => l.startsWith("## "))).toEqual([
      "## replacement-failure @ narrow (44x20, compact) — opens at launch · Esc closes · ctrl-] reopens",
    ]);
    const raw = cli(["preview", "--fixture", "replacement-failure", "--geometry", "narrow", "--raw"]);
    expect(raw.code).toBe(0);
    const home = createPreviewHome();
    try {
      expect(raw.out).toBe(
        renderPreview(PREVIEW_FIXTURES["replacement-failure"], "narrow", home, {
          style: { color: false, attributes: false },
        }).frame,
      );
    } finally {
      home.dispose();
    }
    expect(cli(["preview", "--raw"]).code).toBe(2);
    expect(cli(["preview", "--fixture", "nope"]).code).toBe(2);
    expect(cli(["preview", "--geometry", "huge"]).code).toBe(2);
    expect(cli(["preview", "--bogus"]).code).toBe(2);
    expect(cli(["preview", "--fixture", "nope"]).err).toContain("usage: cc-lhc preview");
  });

  it("honors CC_LHC_LEADER for the reopen key", () => {
    const { code, out } = cli(["preview", "--fixture", "no-messages", "--geometry", "normal"], {
      TERM: "dumb",
      CC_LHC_LEADER: "^A",
    });
    expect(code).toBe(0);
    expect(out).toContain("ctrl-a reopens");
  });
});
