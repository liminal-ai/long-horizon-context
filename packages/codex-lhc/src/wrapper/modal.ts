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
// for the duration and renders the panel on the ALTERNATE SCREEN (panel.ts) —
// this module emits no terminal bytes of its own, it only evolves state.
// Enter executes a command (mode becomes EXECUTING until the command
// settles), Esc/ctrl-C/leader cancel. Ambiguity about "whose input box is
// this" cannot exist by construction — while modal, it is ours.
//
// Leader default is ctrl-] (0x1d), telnet's escape-to-control-channel
// precedent. Ctrl-G was rejected: BEL (0x07) TERMINATES OSC sequences, so a
// BEL on stdin inside an OSC response is protocol, not a keypress.

export const DEFAULT_LEADER_BYTE = 0x1d; // ctrl-]
export const MODAL_HELP_LINE = "commands: status | stats | prune [targetTokens] | compact | help — Esc cancels";
export const MODAL_ASCII_NOTE = "input is ASCII-only — non-ASCII bytes are ignored";
export const MODAL_UNKNOWN_PREFIX = "unknown command: ";

/**
 * Bytes that cannot serve as the leader: NUL, BEL (terminates OSC — a BEL on
 * stdin can be protocol), TAB/LF/CR (typed text), ctrl-C (must keep
 * interrupting the child), ESC (introduces sequences).
 */
const FORBIDDEN_LEADER_BYTES = new Set([0x00, 0x03, 0x07, 0x09, 0x0a, 0x0d, 0x1b]);

/**
 * Resolve CODEX_LHC_LEADER into a single control byte. Accepts a literal control
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
      `codex-lhc: CODEX_LHC_LEADER ${JSON.stringify(raw)} is not a usable control byte (single control char, "^X", or hex like 0x1d; not NUL/BEL/TAB/LF/CR/ctrl-C/ESC) — using ctrl-]`,
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
  /** Receipt/notice lines the panel shows above the prompt (help, unknown, command receipts). */
  panelRows: string[];
}

export type InputAction = { kind: "enter_modal" } | { kind: "exit_modal" } | { kind: "execute"; commandLine: string };

export interface InputResult {
  state: InputState;
  toPty: Buffer;
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
    panelRows: [],
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

/**
 * Reset to passthrough after a completed command with nothing to show; run.ts
 * then leaves the alt screen and flushes the held pty output.
 */
export function finishExecuting(state: InputState): InputState {
  return { ...createInputState(state.leaderByte), inPaste: state.inPaste };
}

/**
 * Settle a command by putting its receipt lines into the panel above a fresh
 * prompt, back in modal mode with the screen still held. The panel owns the
 * alternate screen, so receipts stay readable whatever the main-screen TUI is
 * doing; the user dismisses with one keypress (Esc/ctrl-C/leader/Enter-on-
 * empty), which leaves the alt screen and flushes the held output.
 */
export function showReceipts(state: InputState, lines: string[]): InputState {
  return {
    ...state,
    mode: "modal",
    line: "",
    heldSeq: [],
    escape: null,
    panelRows: lines.flatMap((line) => line.split("\n")),
  };
}

/** Cancel any modal/executing UI unconditionally (held-output overflow path). */
export function forceResetInput(state: InputState): InputState {
  if (state.mode === "passthrough") return state;
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
      // Another ESC: the pending one was a bare keypress; this one may
      // introduce a sequence — stay pending.
      if (byte === 0x1b) return state;
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
    return {
      state: { ...state, mode: "modal", line: "", heldSeq: [], panelRows: [] },
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
    actions: [{ kind: "exit_modal" }],
  };
}

function reprompt(state: InputState, noticeLines: string[]): StepOutcome {
  return { state: { ...state, line: "", panelRows: noticeLines } };
}

function submitModalLine(state: InputState): StepOutcome {
  const trimmed = state.line.trim();
  if (trimmed === "") return cancelModal(state);
  if (trimmed === "help" || trimmed === "?") return reprompt(state, [MODAL_HELP_LINE, MODAL_ASCII_NOTE]);
  const commandLine = mapModalCommand(trimmed);
  if (commandLine === null) {
    return reprompt(state, [`${MODAL_UNKNOWN_PREFIX}${trimmed}`, MODAL_HELP_LINE]);
  }
  // The submitted text stays in `line` so the panel shows what is running;
  // editing is disabled while executing, and settle/detach resets it.
  return {
    state: { ...state, mode: "executing", line: trimmed, panelRows: [] },
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
      return { state: { ...state, line: state.line.slice(0, -1) } };
    case "none":
      return { state };
  }
}

function modalEscapeByte(byte: number, state: InputState): StepOutcome {
  const mode = state.escape;
  if (mode === null) return { state };
  const held = [...state.heldSeq, byte];

  switch (mode.kind) {
    case "pending_esc": {
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
      // Any other byte resolves the held ESC as a bare Esc keypress — this
      // works across chunk boundaries, so a sequence split after its ESC is
      // never misread. While executing, Esc is dropped (ctrl-C detaches);
      // while modal, Esc cancels and the current byte belongs to passthrough.
      const cleared: InputState = { ...state, escape: null, heldSeq: [] };
      if (state.mode === "executing") {
        if (byte === 0x03) return cancelModal(cleared);
        return { state: cleared };
      }
      const cancelled = cancelModal(cleared);
      const after = passthroughByte(byte, cancelled.state);
      return {
        state: after.state,
        toPty: after.toPty ?? Buffer.alloc(0),
        actions: [...(cancelled.actions ?? []), ...(after.actions ?? [])],
      };
    }

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
    if (byte === 0x03) return cancelModal(state);
    if (state.mode === "modal" && byte >= 0x20 && byte <= 0x7e) {
      return { state: { ...state, line: state.line + String.fromCharCode(byte) } };
    }
    return { state };
  }

  if (byte === 0x03) {
    // Modal: cancel. Executing: DETACH — the modal UI is torn down and output
    // resumes, but the in-flight command keeps running (the single-flight
    // guard still serializes); its receipt prints raw on completion and may
    // be repainted over. This is the escape hatch for a hung command.
    return cancelModal(state);
  }

  if (byte === state.leaderByte) {
    if (state.mode === "executing") return { state };
    return cancelModal(state);
  }

  if (state.mode === "executing") return { state };

  if (byte === 0x0d || byte === 0x0a) return submitModalLine(state);
  if (byte === 0x7f || byte === 0x08) return applyModalKey({ kind: "backspace" }, state);
  if (byte === 0x15) {
    return { state: { ...state, line: "" } };
  }
  if (byte >= 0x20 && byte <= 0x7e) {
    return { state: { ...state, line: state.line + String.fromCharCode(byte) } };
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
  const actions: InputAction[] = [];

  for (const byte of chunk) {
    const outcome = current.mode === "passthrough" ? passthroughByte(byte, current) : modalByte(byte, current);
    current = outcome.state;
    if (outcome.toPty !== undefined && outcome.toPty.length > 0) toPty = Buffer.concat([toPty, outcome.toPty]);
    if (outcome.actions !== undefined) actions.push(...outcome.actions);
  }

  // A pending ESC deliberately SURVIVES the chunk boundary: whether it was a
  // bare keypress or the head of a split sequence is decided by the NEXT byte
  // (see the pending_esc cases above). While pending, leader recognition is
  // suppressed — mis-suppressing for one chunk is harmless (leader-again
  // recovers). Bounded ambiguity for a truly bare Esc while modal is run.ts's
  // job: it arms a short timer and calls resolveBareEsc.
  return { state: current, toPty, actions };
}

/**
 * Resolve a pending ESC that no further byte has resolved (run.ts calls this
 * from a ~50ms timer): it was a bare Esc keypress. Modal → cancel; executing
 * → drop it (Esc does not detach; ctrl-C does). Null when nothing is pending
 * or the state has since moved on.
 */
export function resolveBareEsc(state: InputState): { state: InputState; actions: InputAction[] } | null {
  if (state.escape?.kind !== "pending_esc") return null;
  const cleared: InputState = { ...state, escape: null, heldSeq: [] };
  if (state.mode === "modal") {
    const cancelled = cancelModal(cleared);
    return { state: cancelled.state, actions: cancelled.actions ?? [] };
  }
  if (state.mode === "executing") {
    return { state: cleared, actions: [] };
  }
  return null;
}
