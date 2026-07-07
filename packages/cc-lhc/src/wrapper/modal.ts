// Leader-key modal command entry.
//
// Default posture is PASSTHROUGH: every stdin byte forwards to the pty
// untouched. No freshness tracking, no slash detection, no withholding — the
// wrapper no longer estimates Claude Code's input-box state (the shadow-count
// estimator died; it inferred state it did not own). The only state kept in
// passthrough is escape-sequence and bracketed-paste tracking, so the leader
// byte is recognized only as a real keypress — never inside a paste and never
// inside an in-flight terminal response (the Warp lesson: control sequences
// must reach the child verbatim).
//
// On the leader keypress the wrapper goes MODAL: stdin drives our own
// one-line editor and nothing forwards to the pty; run.ts holds pty output
// for the duration. Enter executes a command (mode becomes EXECUTING until
// the command settles), Esc/ctrl-C/leader cancel. Ambiguity about "whose
// input box is this" cannot exist by construction — while modal, it is ours.
//
// Leader default is ctrl-] (0x1d), telnet's escape-to-control-channel
// precedent. Ctrl-G was rejected: BEL (0x07) TERMINATES OSC sequences, so a
// BEL on stdin inside an OSC response is protocol, not a keypress.

export const DEFAULT_LEADER_BYTE = 0x1d; // ctrl-]
export const MODAL_PROMPT = "[lhc] > ";
export const MODAL_HELP_LINE = "commands: status | stats | prune [targetTokens] | compact | help — Esc cancels";
export const MODAL_UNKNOWN_PREFIX = "unknown command: ";

const BACKSPACE_ECHO = "\x08 \x08";
const ERASE_LINE = "\r\x1b[2K";
const CURSOR_UP_ERASE = "\x1b[1A\x1b[2K";

/**
 * Bytes that cannot serve as the leader: NUL, BEL (terminates OSC — a BEL on
 * stdin can be protocol), TAB/LF/CR (typed text), ctrl-C (must keep
 * interrupting the child), ESC (introduces sequences).
 */
const FORBIDDEN_LEADER_BYTES = new Set([0x00, 0x03, 0x07, 0x09, 0x0a, 0x0d, 0x1b]);

/**
 * Resolve CC_LHC_LEADER into a single control byte. Accepts a literal control
 * character, caret notation ("^]"), or hex ("0x1d"). Anything else — or a
 * forbidden byte — warns and falls back to ctrl-].
 */
export function resolveLeaderByte(raw: string | undefined, warn: (message: string) => void = () => {}): number {
  if (raw === undefined || raw === "") return DEFAULT_LEADER_BYTE;
  let byte: number | null = null;
  if (/^0x[0-9a-fA-F]{1,2}$/.test(raw)) byte = Number.parseInt(raw.slice(2), 16);
  else if (raw.length === 1) byte = raw.charCodeAt(0);
  else if (raw.length === 2 && raw.startsWith("^")) byte = raw.charCodeAt(1) & 0x1f;
  if (byte === null || byte <= 0x00 || byte > 0x1f || FORBIDDEN_LEADER_BYTES.has(byte)) {
    warn(
      `cc-lhc: CC_LHC_LEADER ${JSON.stringify(raw)} is not a usable control byte (single control char, "^X", or hex like 0x1d; not NUL/BEL/TAB/LF/CR/ctrl-C/ESC) — using ctrl-]`,
    );
    return DEFAULT_LEADER_BYTE;
  }
  return byte;
}

export type EscapeTracking =
  | { kind: "pending_esc" }
  | { kind: "csi"; params: string }
  | { kind: "string_term" }
  | { kind: "string_term_esc" }
  | { kind: "legacy_mouse"; remaining: number };

export type InputMode = "passthrough" | "modal" | "executing";

export interface InputState {
  mode: InputMode;
  leaderByte: number;
  /** In-flight escape sequence on stdin (terminal responses, mouse, kitty keys). */
  escape: EscapeTracking | null;
  /** Inside a bracketed paste (CSI 200~ … 201~): the leader byte is literal content. */
  inPaste: boolean;
  /** Modal line-editor buffer. */
  line: string;
  /** Escape-sequence bytes held while modal until the sequence classifies (forward vs consume). */
  heldSeq: number[];
  /** Terminal rows our modal UI occupies (prompt + help lines) — erased precisely on exit. */
  rowsWritten: number;
}

export type InputAction = { kind: "enter_modal" } | { kind: "exit_modal" } | { kind: "execute"; commandLine: string };

export interface InputResult {
  state: InputState;
  toPty: Buffer;
  toStdout: string;
  actions: InputAction[];
}

export function createInputState(leaderByte: number = DEFAULT_LEADER_BYTE): InputState {
  return {
    mode: "passthrough",
    leaderByte,
    escape: null,
    inPaste: false,
    line: "",
    heldSeq: [],
    rowsWritten: 0,
  };
}

/** Map a modal command line to the dispatch table's /lhc-* form; null if unknown. */
export function mapModalCommand(line: string): string | null {
  const parts = line.trim().split(/\s+/);
  const name = parts[0] ?? "";
  const args = parts.slice(1);
  switch (name) {
    case "status":
    case "stats":
    case "compact":
      return args.length === 0 ? `/lhc-${name}` : null;
    case "prune":
      if (args.length === 0) return "/lhc-prune";
      if (args.length === 1 && /^\d+$/.test(args[0]!)) return `/lhc-prune ${args[0]}`;
      return null;
    default:
      return null;
  }
}

function eraseModalRows(rows: number): string {
  if (rows <= 0) return "";
  return ERASE_LINE + CURSOR_UP_ERASE.repeat(rows - 1);
}

/**
 * Reset to passthrough after a completed command: erase every row the modal
 * UI wrote. run.ts calls this when a dispatched command settles with nothing
 * to show, then flushes the held pty output.
 */
export function finishExecuting(state: InputState): { state: InputState; toStdout: string } {
  return {
    state: { ...createInputState(state.leaderByte), inPaste: state.inPaste },
    toStdout: eraseModalRows(state.rowsWritten),
  };
}

/**
 * Settle a command by showing its receipt lines as modal rows above a fresh
 * prompt, returning to modal mode with the screen still held. This is the
 * only rendering that survives a running turn: raw prints are overwritten by
 * the TUI's next repaint within a frame (rig-verified), while the modal owns
 * the screen until the user dismisses it (Esc/ctrl-C/leader/Enter-on-empty),
 * which erases every modal row and flushes the held output.
 */
export function showReceipts(state: InputState, lines: string[]): { state: InputState; toStdout: string } {
  const rows = lines.flatMap((line) => line.split("\n"));
  const body = rows.map((row) => `\r\n\x1b[2K[cc-lhc] ${row}`).join("");
  return {
    state: {
      ...state,
      mode: "modal",
      line: "",
      heldSeq: [],
      escape: null,
      rowsWritten: state.rowsWritten + rows.length + 1,
    },
    toStdout: `${body}\r\n\x1b[2K${MODAL_PROMPT}`,
  };
}

/** Cancel any modal/executing UI unconditionally (held-output overflow path). */
export function forceResetInput(state: InputState): { state: InputState; toStdout: string } {
  if (state.mode === "passthrough") return { state, toStdout: "" };
  return finishExecuting(state);
}

function isCsiFinal(byte: number): boolean {
  return byte >= 0x40 && byte <= 0x7e;
}

function isStringTermIntroducer(byte: number): boolean {
  return byte === 0x5d || byte === 0x50 || byte === 0x5e || byte === 0x5f || byte === 0x58;
}

/**
 * Key code of a kitty CSI-u keypress (press or repeat), or null for release
 * events and unparseable params. Format: code[:alts];modifiers[:event];text —
 * event 3 is a release and must not act twice.
 */
function kittyKeyPressCode(params: string): number | null {
  const fields = params.split(";");
  const code = Number.parseInt(fields[0] ?? "", 10);
  if (!Number.isFinite(code)) return null;
  const event = fields[1]?.split(":")[1];
  if (event === "3") return null;
  return code;
}

/** CSI finals for cursor/navigation keys — user keys, dropped while modal. */
function isNavigationCsi(finalByte: number): boolean {
  // A/B/C/D arrows, E/F/H home-end variants, ~ (del/pgup/pgdn/…)
  return (
    finalByte === 0x41 ||
    finalByte === 0x42 ||
    finalByte === 0x43 ||
    finalByte === 0x44 ||
    finalByte === 0x45 ||
    finalByte === 0x46 ||
    finalByte === 0x48 ||
    finalByte === 0x7e
  );
}

/** SGR mouse reports (CSI < … M/m) — dropped while modal; the screen is frozen. */
function isMouseCsi(params: string, finalByte: number): boolean {
  return (finalByte === 0x4d || finalByte === 0x6d) && params.startsWith("<");
}

type ModalKey = { kind: "enter" } | { kind: "cancel" } | { kind: "backspace" } | { kind: "none" };

interface StepOutcome {
  state: InputState;
  toPty?: Buffer;
  toStdout?: string;
  actions?: InputAction[];
}

// ---------------------------------------------------------------------------
// Passthrough
// ---------------------------------------------------------------------------

/**
 * Advance escape/paste tracking for one forwarded byte. Passthrough never
 * withholds: this exists solely so the leader byte is not misread as a
 * keypress inside a sequence or a paste.
 */
function trackForwardedEscapeByte(byte: number, state: InputState): InputState {
  const mode = state.escape;
  if (mode === null) return state;
  switch (mode.kind) {
    case "pending_esc":
      if (byte === 0x5b) return { ...state, escape: { kind: "csi", params: "" } };
      if (isStringTermIntroducer(byte)) return { ...state, escape: { kind: "string_term" } };
      if (byte === 0x4d) return { ...state, escape: { kind: "legacy_mouse", remaining: 3 } };
      return { ...state, escape: null };
    case "csi":
      if (isCsiFinal(byte)) {
        let inPaste = state.inPaste;
        if (byte === 0x7e && mode.params === "200") inPaste = true;
        if (byte === 0x7e && mode.params === "201") inPaste = false;
        return { ...state, escape: null, inPaste };
      }
      return { ...state, escape: { kind: "csi", params: mode.params + String.fromCharCode(byte) } };
    case "string_term":
      if (byte === 0x07) return { ...state, escape: null };
      if (byte === 0x1b) return { ...state, escape: { kind: "string_term_esc" } };
      return state;
    case "string_term_esc":
      if (byte === 0x5c) return { ...state, escape: null };
      return { ...state, escape: { kind: "pending_esc" } };
    case "legacy_mouse": {
      const remaining = mode.remaining - 1;
      return { ...state, escape: remaining <= 0 ? null : { kind: "legacy_mouse", remaining } };
    }
  }
}

function passthroughByte(byte: number, state: InputState): StepOutcome {
  if (state.escape !== null) {
    return { state: trackForwardedEscapeByte(byte, state), toPty: Buffer.from([byte]) };
  }
  if (byte === 0x1b) {
    return { state: { ...state, escape: { kind: "pending_esc" } }, toPty: Buffer.from([byte]) };
  }
  if (!state.inPaste && byte === state.leaderByte) {
    // \x1b[2K clears whatever TUI content already sits on the prompt's row.
    return {
      state: { ...state, mode: "modal", line: "", heldSeq: [], rowsWritten: 1 },
      toStdout: `\r\n\x1b[2K${MODAL_PROMPT}`,
      actions: [{ kind: "enter_modal" }],
    };
  }
  return { state, toPty: Buffer.from([byte]) };
}

// ---------------------------------------------------------------------------
// Modal / executing
// ---------------------------------------------------------------------------

function cancelModal(state: InputState): StepOutcome {
  return {
    state: { ...createInputState(state.leaderByte), inPaste: state.inPaste },
    toStdout: eraseModalRows(state.rowsWritten),
    actions: [{ kind: "exit_modal" }],
  };
}

function reprompt(state: InputState, noticeLines: string[]): StepOutcome {
  const body = noticeLines.map((line) => `\r\n\x1b[2K${line}`).join("");
  return {
    state: { ...state, line: "", rowsWritten: state.rowsWritten + noticeLines.length + 1 },
    toStdout: `${body}\r\n\x1b[2K${MODAL_PROMPT}`,
  };
}

function submitModalLine(state: InputState): StepOutcome {
  const trimmed = state.line.trim();
  if (trimmed === "") return cancelModal(state);
  if (trimmed === "help" || trimmed === "?") return reprompt(state, [MODAL_HELP_LINE]);
  const commandLine = mapModalCommand(trimmed);
  if (commandLine === null) {
    return reprompt(state, [`${MODAL_UNKNOWN_PREFIX}${trimmed}`, MODAL_HELP_LINE]);
  }
  // Prompt row stays visible while the command runs; run.ts erases it (via
  // finishExecuting) when the command settles, then prints receipts.
  return {
    state: { ...state, mode: "executing", line: "" },
    actions: [{ kind: "execute", commandLine }],
  };
}

/**
 * Handle a completed escape sequence while modal/executing. Kitty CSI-u keys
 * are OUR editor's keys (consumed); navigation/mouse are user keys aimed at a
 * frozen screen (dropped); everything else is presumed protocol traffic —
 * terminal responses belong to the child, so the held bytes forward verbatim.
 */
function classifyModalCsi(params: string, finalByte: number): { key: ModalKey; forward: boolean } {
  if (finalByte === 0x75) {
    const key = kittyKeyPressCode(params);
    if (key === 13) return { key: { kind: "enter" }, forward: false };
    if (key === 27) return { key: { kind: "cancel" }, forward: false };
    if (key === 127) return { key: { kind: "backspace" }, forward: false };
    return { key: { kind: "none" }, forward: false };
  }
  if (params === "200" && finalByte === 0x7e) return { key: { kind: "none" }, forward: false };
  if (params === "201" && finalByte === 0x7e) return { key: { kind: "none" }, forward: false };
  if (isMouseCsi(params, finalByte)) return { key: { kind: "none" }, forward: false };
  if (isNavigationCsi(finalByte)) return { key: { kind: "none" }, forward: false };
  return { key: { kind: "none" }, forward: true };
}

function applyModalKey(key: ModalKey, state: InputState): StepOutcome {
  if (state.mode === "executing") return { state };
  switch (key.kind) {
    case "enter":
      return submitModalLine(state);
    case "cancel":
      return cancelModal(state);
    case "backspace":
      if (state.line.length === 0) return { state };
      return { state: { ...state, line: state.line.slice(0, -1) }, toStdout: BACKSPACE_ECHO };
    case "none":
      return { state };
  }
}

function modalEscapeByte(byte: number, state: InputState): StepOutcome {
  const mode = state.escape;
  if (mode === null) return { state };
  const held = [...state.heldSeq, byte];

  switch (mode.kind) {
    case "pending_esc":
      if (byte === 0x5b) {
        return { state: { ...state, escape: { kind: "csi", params: "" }, heldSeq: held } };
      }
      if (isStringTermIntroducer(byte)) {
        // A string sequence (OSC/DCS/…) on stdin is a terminal response in
        // flight to the child: forward the held introducer now and stream the
        // rest through as it arrives.
        return {
          state: { ...state, escape: { kind: "string_term" }, heldSeq: [] },
          toPty: Buffer.from(held),
        };
      }
      if (byte === 0x4d) {
        return { state: { ...state, escape: { kind: "legacy_mouse", remaining: 3 }, heldSeq: held } };
      }
      // Alt-key chord or terminal noise — not a key for our editor, and not a
      // sequence the child is waiting on. Drop both bytes.
      return { state: { ...state, escape: null, heldSeq: [] } };

    case "csi": {
      if (!isCsiFinal(byte)) {
        return {
          state: { ...state, escape: { kind: "csi", params: mode.params + String.fromCharCode(byte) }, heldSeq: held },
        };
      }
      const { key, forward } = classifyModalCsi(mode.params, byte);
      let inPaste = state.inPaste;
      if (byte === 0x7e && mode.params === "200") inPaste = true;
      if (byte === 0x7e && mode.params === "201") inPaste = false;
      const cleared: InputState = { ...state, escape: null, heldSeq: [], inPaste };
      if (forward) return { state: cleared, toPty: Buffer.from(held) };
      return applyModalKey(key, cleared);
    }

    case "string_term":
      if (byte === 0x07) return { state: { ...state, escape: null }, toPty: Buffer.from([byte]) };
      if (byte === 0x1b)
        return { state: { ...state, escape: { kind: "string_term_esc" } }, toPty: Buffer.from([byte]) };
      return { state, toPty: Buffer.from([byte]) };

    case "string_term_esc":
      if (byte === 0x5c) return { state: { ...state, escape: null }, toPty: Buffer.from([byte]) };
      return { state: { ...state, escape: { kind: "pending_esc" } }, toPty: Buffer.from([byte]) };

    case "legacy_mouse": {
      const remaining = mode.remaining - 1;
      if (remaining <= 0) return { state: { ...state, escape: null, heldSeq: [] } };
      return { state: { ...state, escape: { kind: "legacy_mouse", remaining }, heldSeq: held } };
    }
  }
}

function modalByte(byte: number, state: InputState): StepOutcome {
  if (state.escape !== null) return modalEscapeByte(byte, state);

  if (byte === 0x1b) {
    // Held, not forwarded: a lone-ESC chunk is a cancel keypress (detected
    // after the chunk loop); ESC followed by more bytes is a sequence.
    return { state: { ...state, escape: { kind: "pending_esc" }, heldSeq: [byte] } };
  }

  if (state.inPaste) {
    // Pasted content while modal: printables append; a pasted newline is
    // literal content with no line to live in, so it is dropped rather than
    // treated as a submit; control bytes (including the leader) are ignored —
    // except ctrl-C, kept as the escape hatch if a paste never closes.
    if (byte === 0x03 && state.mode === "modal") return cancelModal(state);
    if (state.mode === "modal" && byte >= 0x20 && byte <= 0x7e) {
      return { state: { ...state, line: state.line + String.fromCharCode(byte) }, toStdout: String.fromCharCode(byte) };
    }
    return { state };
  }

  if (byte === state.leaderByte || byte === 0x03) {
    if (state.mode === "executing") return { state };
    return cancelModal(state);
  }

  if (state.mode === "executing") return { state };

  if (byte === 0x0d || byte === 0x0a) return submitModalLine(state);
  if (byte === 0x7f || byte === 0x08) return applyModalKey({ kind: "backspace" }, state);
  if (byte === 0x15) {
    if (state.line.length === 0) return { state };
    return { state: { ...state, line: "" }, toStdout: BACKSPACE_ECHO.repeat(state.line.length) };
  }
  if (byte >= 0x20 && byte <= 0x7e) {
    return { state: { ...state, line: state.line + String.fromCharCode(byte) }, toStdout: String.fromCharCode(byte) };
  }
  // Remaining C0 controls and non-ASCII bytes: the editor is ASCII-only.
  return { state };
}

// ---------------------------------------------------------------------------
// Chunk loop
// ---------------------------------------------------------------------------

export function processInputChunk(chunk: Buffer, state: InputState): InputResult {
  let current = state;
  let toPty = Buffer.alloc(0);
  let toStdout = "";
  const actions: InputAction[] = [];

  for (const byte of chunk) {
    const outcome = current.mode === "passthrough" ? passthroughByte(byte, current) : modalByte(byte, current);
    current = outcome.state;
    if (outcome.toPty !== undefined && outcome.toPty.length > 0) toPty = Buffer.concat([toPty, outcome.toPty]);
    if (outcome.toStdout !== undefined) toStdout += outcome.toStdout;
    if (outcome.actions !== undefined) actions.push(...outcome.actions);
  }

  // A lone \x1b chunk is a bare Esc keypress (sequences arrive with their
  // introducer in the same read). Passthrough already forwarded it — just
  // clear the tracking. Modal holds it — cancel. Executing — drop it.
  if (current.escape?.kind === "pending_esc" && chunk.length === 1 && chunk[0] === 0x1b) {
    if (current.mode === "modal") {
      const cancelled = cancelModal({ ...current, escape: null, heldSeq: [] });
      current = cancelled.state;
      toStdout += cancelled.toStdout ?? "";
      if (cancelled.actions !== undefined) actions.push(...cancelled.actions);
    } else {
      current = { ...current, escape: null, heldSeq: [] };
    }
  }

  return { state: current, toPty, toStdout, actions };
}
