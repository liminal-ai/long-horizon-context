import type { BandAllocationId } from "../governor/band-allocation.js";
import { PRODUCT_PRESET_IDS } from "../governor/band-allocation.js";
import { readonlyBodyLineCount } from "./panel.js";
import {
  allocationIndex,
  commandSuggestions,
  completeCommandLine,
  exactCommandName,
  HOME_ACTIONS,
  homeCursorLength,
  homeSelectedActionIndex,
  isReadonlyRoute,
  MODAL_ASCII_NOTE,
  MODAL_SCOPE_NOTE,
  MODAL_UNKNOWN_HINT,
  MODAL_UNKNOWN_PREFIX,
  mapModalCommand,
  type PanelRoute,
  type PanelViewport,
  type PanelViewSnapshot,
  parsePanelCommand,
} from "./panel-commands.js";

export const DEFAULT_LEADER_BYTE = 0x1d;
export {
  isReadonlyRoute,
  MODAL_ASCII_NOTE,
  MODAL_SCOPE_NOTE,
  MODAL_UNKNOWN_HINT,
  MODAL_UNKNOWN_PREFIX,
  mapModalCommand,
  type PanelRoute,
  type PanelViewport,
  type PanelViewSnapshot,
};

/**
 * Bytes that cannot serve as the leader: NUL, BEL (terminates OSC — a BEL on
 * stdin can be protocol), TAB/LF/CR (typed text), ctrl-C (must keep
 * interrupting the child), ESC (introduces sequences).
 */
const FORBIDDEN_LEADER_BYTES = new Set([0x00, 0x03, 0x07, 0x09, 0x0a, 0x0d, 0x1b]);

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
  | { kind: "csi_candidate"; params: string }
  | { kind: "string_term" }
  | { kind: "string_term_esc" }
  | { kind: "legacy_mouse"; remaining: number };

export type InputMode = "passthrough" | "modal" | "executing" | "notifier";

export const SESSION_SWITCHING_COMMANDS = ["/resume", "/clear", "/compact", "/branch"] as const;

export function matchHazardousCommand(line: string): string | null {
  const trimmed = line.trim();
  for (const command of SESSION_SWITCHING_COMMANDS) {
    if (trimmed === command || trimmed.startsWith(`${command} `)) return command;
  }
  return null;
}

const HAZARD_LINE_CAP = 200;

export interface InputState {
  mode: InputMode;
  leaderByte: number;
  escape: EscapeTracking | null;
  inPaste: boolean;
  line: string;
  heldSeq: number[];
  panelRows: string[];
  hazardLine: string;
  hazardPoisoned: boolean;
  notifierEnabled: boolean;
  heldEnter: number[];
  notifierCommand: string;
  route: PanelRoute;
  suggestionIndex: number;
  viewport: PanelViewport;
  panelView: PanelViewSnapshot | null;
}

export type InputAction =
  | { kind: "enter_modal" }
  | { kind: "exit_modal" }
  | { kind: "execute"; commandLine: string }
  | { kind: "notifier_open"; command: string }
  | { kind: "notifier_continue"; enterBytes: number[] }
  | { kind: "notifier_return" }
  | { kind: "select_allocation"; id: BandAllocationId };

export interface InputResult {
  state: InputState;
  toPty: Buffer;
  actions: InputAction[];
}

export function createInputState(
  leaderByte: number = DEFAULT_LEADER_BYTE,
  options: { notifierEnabled?: boolean } = {},
): InputState {
  return {
    mode: "passthrough",
    leaderByte,
    escape: null,
    inPaste: false,
    line: "",
    heldSeq: [],
    panelRows: [],
    hazardLine: "",
    hazardPoisoned: false,
    notifierEnabled: options.notifierEnabled ?? true,
    heldEnter: [],
    notifierCommand: "",
    route: "home",
    suggestionIndex: 0,
    viewport: { scrollOffset: 0, selectedIndex: -1 },
    panelView: null,
  };
}

export function suggestionsOpen(state: InputState): boolean {
  if (state.mode !== "modal" || state.route !== "home") return false;
  return commandSuggestions(state.line).length > 0;
}

export function selectedSuggestion(state: InputState): { name: string; usage: string; description: string } | null {
  const suggestions = commandSuggestions(state.line);
  if (suggestions.length === 0 || state.mode !== "modal" || state.route !== "home") return null;
  const index = Math.max(0, Math.min(suggestions.length - 1, state.suggestionIndex));
  return suggestions[index] ?? null;
}

function withLine(state: InputState, line: string): InputState {
  return { ...state, line, suggestionIndex: 0 };
}

function completeSuggestion(state: InputState): StepOutcome {
  const suggestion = selectedSuggestion(state);
  if (suggestion === null) return { state };
  return { state: withLine(state, completeCommandLine(state.line, suggestion.name)) };
}

export function finishExecuting(state: InputState): InputState {
  return {
    ...createInputState(state.leaderByte, { notifierEnabled: state.notifierEnabled }),
    inPaste: state.inPaste,
  };
}

export function showReceipts(state: InputState, lines: string[]): InputState {
  return {
    ...state,
    mode: "modal",
    route: "home",
    line: "",
    heldSeq: [],
    escape: null,
    panelRows: lines.flatMap((line) => line.split("\n")),
  };
}

export function clampPanelViewport(state: InputState, _cols: number, rows: number): InputState {
  if (state.mode === "passthrough" || state.mode === "notifier") {
    return state;
  }
  const safeRows = Math.max(5, rows);
  if (state.route === "allocation") {
    const max = PRODUCT_PRESET_IDS.length - 1;
    const selectedIndex = Math.max(0, Math.min(max, state.viewport.selectedIndex));
    return { ...state, viewport: { scrollOffset: 0, selectedIndex } };
  }
  if (state.route === "home") {
    const max = Math.max(0, homeCursorLength() - 1);
    const scrollOffset = Math.max(0, Math.min(max, state.viewport.scrollOffset));
    return { ...state, viewport: { scrollOffset, selectedIndex: homeSelectedActionIndex(scrollOffset) } };
  }
  const body = readonlyBodyLineCount(state, _cols, safeRows);
  const visible = Math.max(1, safeRows - 4);
  const maxScroll = Math.max(0, body - visible);
  const scrollOffset = Math.max(0, Math.min(maxScroll, state.viewport.scrollOffset));
  return { ...state, viewport: { ...state.viewport, scrollOffset } };
}

export function showLateReceipts(state: InputState, label: string, lines: string[]): InputState {
  return {
    ...state,
    panelRows: [`${label} finished:`, ...lines.flatMap((line) => line.split("\n"))],
  };
}

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

export function kittyLeaderCode(leaderByte: number): number {
  return leaderByte <= 0x1a ? leaderByte + 96 : leaderByte + 64;
}

export function isKittyLeaderParams(params: string, leaderByte: number): boolean {
  const fields = params.split(";");
  const code = Number.parseInt(fields[0] ?? "", 10);
  if (!Number.isFinite(code) || code !== kittyLeaderCode(leaderByte)) return false;
  const [modifierPart, eventPart] = (fields[1] ?? "").split(":");
  if (Number.parseInt(modifierPart ?? "", 10) !== 5) return false;
  const event = eventPart === undefined || eventPart === "" ? 1 : Number.parseInt(eventPart, 10);
  return event === 1 || event === 2;
}

/**
 * True when CSI ...~ parameters are the xterm modifyOtherKeys encoding of the
 * leader: CSI 27;5;<code>~ (ctrl-only, press events only — this encoding has
 * no releases). Observed live: tmux with extended-keys delivers ctrl-] this
 * way (27;5;93~) rather than as kitty CSI-u.
 */
export function isModifyOtherKeysLeaderParams(params: string, leaderByte: number): boolean {
  const fields = params.split(";");
  if (fields.length !== 3) return false;
  const code = fields[2] ?? "";
  if (!/^\d+$/.test(code)) return false;
  return fields[0] === "27" && fields[1] === "5" && Number.parseInt(code, 10) === kittyLeaderCode(leaderByte);
}

export interface Win32KeyEvent {
  virtualKey: number;
  scanCode: number;
  unicodeChar: number;
  keyDown: boolean;
  controlKeyState: number;
  repeatCount: number;
}

export function parseWin32KeyParams(params: string): Win32KeyEvent | null {
  const fields = params.split(";");
  if (fields.length !== 6 || fields.some((field) => !/^\d*$/.test(field))) return null;
  const values = fields.map((field) => (field === "" ? 0 : Number.parseInt(field, 10)));
  if (values.some((value) => !Number.isSafeInteger(value))) return null;
  if (values[3] !== 0 && values[3] !== 1) return null;
  return {
    virtualKey: values[0]!,
    scanCode: values[1]!,
    unicodeChar: values[2]!,
    keyDown: values[3] === 1,
    controlKeyState: values[4]!,
    repeatCount: values[5]!,
  };
}

export function isWin32LeaderParams(params: string, leaderByte: number): boolean {
  const event = parseWin32KeyParams(params);
  return event?.keyDown === true && event.unicodeChar === leaderByte;
}

function isWin32ModifierEvent(event: Win32KeyEvent): boolean {
  return (
    event.virtualKey === 0x10 ||
    event.virtualKey === 0x11 ||
    event.virtualKey === 0x12 ||
    event.virtualKey === 0x5b ||
    event.virtualKey === 0x5c ||
    (event.virtualKey >= 0xa0 && event.virtualKey <= 0xa5)
  );
}

function isNavigationCsi(finalByte: number): boolean {
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

function isMouseCsi(params: string, finalByte: number): boolean {
  return (finalByte === 0x4d || finalByte === 0x6d) && params.startsWith("<");
}

type ModalKey =
  | { kind: "enter" }
  | { kind: "cancel" }
  | { kind: "complete" }
  | { kind: "backspace" }
  | { kind: "clear" }
  | { kind: "text"; value: string }
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "none" };

interface StepOutcome {
  state: InputState;
  toPty?: Buffer;
  actions?: InputAction[];
}

function trackForwardedEscapeByte(byte: number, state: InputState): InputState {
  const mode = state.escape;
  if (mode === null) return state;
  switch (mode.kind) {
    case "pending_esc":
      if (byte === 0x5b) return { ...state, escape: { kind: "csi", params: "" } };
      if (isStringTermIntroducer(byte)) return { ...state, escape: { kind: "string_term" } };
      if (byte === 0x4d) return { ...state, escape: { kind: "legacy_mouse", remaining: 3 } };
      if (byte === 0x1b) return state;
      return { ...state, escape: null };
    case "csi":
    case "csi_candidate":
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

function enterModal(state: InputState): StepOutcome {
  return {
    state: {
      ...state,
      mode: "modal",
      escape: null,
      line: "",
      heldSeq: [],
      panelRows: [],
      route: "home",
      viewport: { scrollOffset: 0, selectedIndex: -1 },
    },
    actions: [{ kind: "enter_modal" }],
  };
}

function isCandidateParamByte(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39) || byte === 0x3b || byte === 0x3a;
}

const CSI_CANDIDATE_PARAMS_CAP = 32;

function passthroughEscapeByte(byte: number, state: InputState): StepOutcome {
  const mode = state.escape;
  if (mode === null) return { state, toPty: Buffer.from([byte]) };
  const held = [...state.heldSeq, byte];

  switch (mode.kind) {
    case "pending_esc":
      if (byte === 0x5b) {
        return { state: { ...state, escape: { kind: "csi_candidate", params: "" }, heldSeq: held } };
      }
      if (isStringTermIntroducer(byte)) {
        return {
          state: { ...state, escape: { kind: "string_term" }, heldSeq: [] },
          toPty: Buffer.from(held),
        };
      }
      if (byte === 0x4d) {
        return {
          state: hazardPoison({ ...state, escape: { kind: "legacy_mouse", remaining: 3 }, heldSeq: [] }),
          toPty: Buffer.from(held),
        };
      }
      if (byte === 0x1b) {
        return { state: hazardPoison({ ...state, heldSeq: [0x1b] }), toPty: Buffer.from(state.heldSeq) };
      }
      return { state: hazardPoison({ ...state, escape: null, heldSeq: [] }), toPty: Buffer.from(held) };

    case "csi_candidate": {
      if (isCsiFinal(byte)) {
        const win32 = byte === 0x5f ? parseWin32KeyParams(mode.params) : null;
        const isLeaderKey =
          (byte === 0x75 && isKittyLeaderParams(mode.params, state.leaderByte)) ||
          (byte === 0x7e && isModifyOtherKeysLeaderParams(mode.params, state.leaderByte)) ||
          (byte === 0x5f && isWin32LeaderParams(mode.params, state.leaderByte));
        if (isLeaderKey && !state.inPaste) {
          return enterModal({ ...state, escape: null, heldSeq: [] });
        }
        if (byte === 0x75 && isKittyPlainEnterParams(mode.params) && !state.inPaste) {
          const cleared = { ...state, escape: null, heldSeq: [] };
          const opened = maybeOpenNotifier(cleared, held);
          if (opened !== null) return opened;
          return { state: hazardBoundary(cleared), toPty: Buffer.from(held) };
        }
        if (win32 !== null) {
          const cleared = { ...state, escape: null, heldSeq: [] };
          if (state.inPaste) {
            return { state: hazardPoison(cleared), toPty: Buffer.from(held) };
          }
          if (!win32.keyDown || isWin32ModifierEvent(win32)) {
            return { state: cleared, toPty: Buffer.from(held) };
          }
          if (win32.unicodeChar === 0x0d) {
            const opened = maybeOpenNotifier(cleared, held);
            if (opened !== null) return opened;
            return { state: hazardBoundary(cleared), toPty: Buffer.from(held) };
          }
          if (win32.unicodeChar === 0x03) {
            return { state: hazardBoundary(cleared), toPty: Buffer.from(held) };
          }
          if (win32.unicodeChar >= 0x20 && win32.unicodeChar <= 0x7e) {
            return { state: hazardAppend(cleared, win32.unicodeChar), toPty: Buffer.from(held) };
          }
          return { state: hazardPoison(cleared), toPty: Buffer.from(held) };
        }
        let inPaste = state.inPaste;
        if (byte === 0x7e && mode.params === "200") inPaste = true;
        if (byte === 0x7e && mode.params === "201") inPaste = false;
        const next = { ...state, escape: null, heldSeq: [], inPaste };
        return {
          state: isNeutralPassthroughCsi(mode.params, byte) ? next : hazardPoison(next),
          toPty: Buffer.from(held),
        };
      }
      if (isCandidateParamByte(byte) && mode.params.length < CSI_CANDIDATE_PARAMS_CAP) {
        return {
          state: {
            ...state,
            escape: { kind: "csi_candidate", params: mode.params + String.fromCharCode(byte) },
            heldSeq: held,
          },
        };
      }
      return {
        state: {
          ...state,
          escape: { kind: "csi", params: mode.params + String.fromCharCode(byte) },
          heldSeq: [],
        },
        toPty: Buffer.from(held),
      };
    }

    default: {
      const wasCsi = mode.kind === "csi";
      const wasMouse = mode.kind === "legacy_mouse";
      const nextState = trackForwardedEscapeByte(byte, state);
      let out = nextState;
      if (wasCsi && isCsiFinal(byte) && !isNeutralPassthroughCsi(mode.kind === "csi" ? mode.params : "", byte)) {
        out = hazardPoison(out);
      }
      if (wasMouse && nextState.escape === null) {
        out = hazardPoison(out);
      }
      return { state: out, toPty: Buffer.from([byte]) };
    }
  }
}

function passthroughByte(byte: number, state: InputState): StepOutcome {
  if (state.escape !== null) {
    return passthroughEscapeByte(byte, state);
  }
  if (byte === 0x1b) {
    return { state: { ...state, escape: { kind: "pending_esc" }, heldSeq: [0x1b] } };
  }
  if (!state.inPaste && byte === state.leaderByte) {
    return enterModal(state);
  }
  if (state.inPaste) {
    return { state: hazardPoison(state), toPty: Buffer.from([byte]) };
  }
  if (byte === 0x0d) {
    const opened = maybeOpenNotifier(state, [0x0d]);
    if (opened !== null) return opened;
    return { state: hazardBoundary(state), toPty: Buffer.from([byte]) };
  }
  if (byte === 0x0a || byte === 0x03) {
    return { state: hazardBoundary(state), toPty: Buffer.from([byte]) };
  }
  if (byte >= 0x20 && byte <= 0x7e) {
    return { state: hazardAppend(state, byte), toPty: Buffer.from([byte]) };
  }
  return { state: hazardPoison(state), toPty: Buffer.from([byte]) };
}

function cancelModal(state: InputState): StepOutcome {
  if (state.mode === "notifier") return notifierResolve(state, false);
  return {
    state: {
      ...createInputState(state.leaderByte, { notifierEnabled: state.notifierEnabled }),
      inPaste: state.inPaste,
    },
    actions: [{ kind: "exit_modal" }],
  };
}

function notifierResolve(state: InputState, forward: boolean): StepOutcome {
  const base: InputState = {
    ...createInputState(state.leaderByte, { notifierEnabled: state.notifierEnabled }),
    inPaste: state.inPaste,
  };
  if (forward) {
    return { state: base, actions: [{ kind: "notifier_continue", enterBytes: state.heldEnter }] };
  }
  return {
    state: { ...base, hazardLine: state.hazardLine },
    actions: [{ kind: "notifier_return" }],
  };
}

function hazardPoison(state: InputState): InputState {
  if (!state.notifierEnabled || state.hazardPoisoned) return state;
  return { ...state, hazardPoisoned: true };
}
function hazardBoundary(state: InputState): InputState {
  if (!state.notifierEnabled) return state;
  return { ...state, hazardLine: "", hazardPoisoned: false };
}
function hazardAppend(state: InputState, byte: number): InputState {
  if (!state.notifierEnabled || state.hazardPoisoned) return state;
  if (state.hazardLine.length >= HAZARD_LINE_CAP) return hazardPoison(state);
  return { ...state, hazardLine: state.hazardLine + String.fromCharCode(byte) };
}

function isNeutralPassthroughCsi(params: string, finalByte: number): boolean {
  if (params.startsWith("?")) return true;
  if (finalByte === 0x52) return true;
  if ((finalByte === 0x49 || finalByte === 0x4f) && params === "") return true;
  return false;
}

function isKittyPlainEnterParams(params: string): boolean {
  const fields = params.split(";");
  if (Number.parseInt(fields[0] ?? "", 10) !== 13) return false;
  const [modifierPart, eventPart] = (fields[1] ?? "").split(":");
  if (modifierPart !== undefined && modifierPart !== "" && Number.parseInt(modifierPart, 10) !== 1) return false;
  const event = eventPart === undefined || eventPart === "" ? 1 : Number.parseInt(eventPart, 10);
  return event === 1 || event === 2;
}

function maybeOpenNotifier(state: InputState, enterBytes: number[]): StepOutcome | null {
  if (!state.notifierEnabled || state.inPaste || state.hazardPoisoned) return null;
  const command = matchHazardousCommand(state.hazardLine);
  if (command === null) return null;
  return {
    state: {
      ...state,
      mode: "notifier",
      escape: null,
      heldSeq: [],
      heldEnter: enterBytes,
      notifierCommand: command,
      panelRows: [],
    },
    actions: [{ kind: "notifier_open", command }],
  };
}

function reprompt(state: InputState, noticeLines: string[]): StepOutcome {
  return { state: { ...state, line: "", suggestionIndex: 0, panelRows: noticeLines, route: "home" } };
}

function openRoute(state: InputState, route: PanelRoute): StepOutcome {
  const selectedIndex =
    route === "allocation" ? allocationIndex(state.panelView?.allocationId ?? "default") : route === "home" ? -1 : 0;
  return {
    state: {
      ...state,
      route,
      line: "",
      suggestionIndex: 0,
      viewport: { scrollOffset: 0, selectedIndex },
      panelRows: route === "home" ? state.panelRows : [],
    },
  };
}

function applyAllocation(state: InputState): StepOutcome {
  const id =
    PRODUCT_PRESET_IDS[Math.max(0, Math.min(PRODUCT_PRESET_IDS.length - 1, state.viewport.selectedIndex))] ?? "default";
  return {
    state: {
      ...state,
      route: "home",
      line: "",
      viewport: { scrollOffset: 0, selectedIndex: -1 },
    },
    actions: [{ kind: "select_allocation", id }],
  };
}

function activateHomeAction(state: InputState): StepOutcome {
  const action = HOME_ACTIONS[state.viewport.selectedIndex];
  if (action === undefined) return cancelModal(state);
  if (action.kind === "route") return openRoute(state, action.route);
  return submitCommandText(state, action.command);
}

function submitCommandText(state: InputState, text: string): StepOutcome {
  const parsed = parsePanelCommand(text);
  if (parsed.kind === "route") return openRoute(state, parsed.route);
  if (parsed.kind === "invalid") return reprompt(state, [parsed.message]);
  if (parsed.kind === "needs_slash") {
    return reprompt(state, [MODAL_UNKNOWN_HINT]);
  }
  if (parsed.kind === "unknown") {
    return reprompt(state, [`${MODAL_UNKNOWN_PREFIX}${text}`, MODAL_UNKNOWN_HINT]);
  }
  return {
    state: { ...state, mode: "executing", route: "home", line: parsed.surface, suggestionIndex: 0, panelRows: [] },
    actions: [{ kind: "execute", commandLine: parsed.commandLine }],
  };
}

function submitModalLine(state: InputState): StepOutcome {
  if (isReadonlyRoute(state.route)) return openRoute(state, "home");
  if (state.route === "allocation") return applyAllocation(state);
  const trimmed = state.line.trim();
  if (trimmed === "") {
    if (state.viewport.selectedIndex >= 0) return activateHomeAction(state);
    return cancelModal(state);
  }
  if (exactCommandName(trimmed) === null && commandSuggestions(trimmed).length > 0) {
    return completeSuggestion(state);
  }
  return submitCommandText(state, trimmed);
}

function classifyModalCsi(params: string, finalByte: number, state: InputState): { key: ModalKey; forward: boolean } {
  if (finalByte === 0x5f) {
    const event = parseWin32KeyParams(params);
    if (event !== null) {
      if (!event.keyDown || isWin32ModifierEvent(event)) return { key: { kind: "none" }, forward: false };
      if (!state.inPaste && (event.unicodeChar === state.leaderByte || event.unicodeChar === 0x03)) {
        return { key: { kind: "cancel" }, forward: false };
      }
      if (event.unicodeChar === 0x0d) return { key: { kind: "enter" }, forward: false };
      if (event.unicodeChar === 0x1b) return { key: { kind: "cancel" }, forward: false };
      if (event.unicodeChar === 0x08 || event.unicodeChar === 0x7f) {
        return { key: { kind: "backspace" }, forward: false };
      }
      if (event.unicodeChar === 0x15) return { key: { kind: "clear" }, forward: false };
      if (event.unicodeChar === 0x09 || event.virtualKey === 0x09) {
        return { key: { kind: "complete" }, forward: false };
      }
      if (event.virtualKey === 0x26) return { key: { kind: "up" }, forward: false };
      if (event.virtualKey === 0x28) return { key: { kind: "down" }, forward: false };
      if (event.unicodeChar >= 0x20 && event.unicodeChar <= 0x7e) {
        return { key: { kind: "text", value: String.fromCharCode(event.unicodeChar) }, forward: false };
      }
      return { key: { kind: "none" }, forward: false };
    }
  }
  const encodedLeader =
    (finalByte === 0x75 && isKittyLeaderParams(params, state.leaderByte)) ||
    (finalByte === 0x7e && isModifyOtherKeysLeaderParams(params, state.leaderByte));
  if (encodedLeader && !state.inPaste) {
    return { key: { kind: "cancel" }, forward: false };
  }
  const encodedCtrlC =
    (finalByte === 0x75 && isKittyLeaderParams(params, 0x03)) ||
    (finalByte === 0x7e && isModifyOtherKeysLeaderParams(params, 0x03));
  if (encodedCtrlC && !state.inPaste) {
    return { key: { kind: "cancel" }, forward: false };
  }
  if (finalByte === 0x75) {
    const key = kittyKeyPressCode(params);
    if (key === 9) return { key: { kind: "complete" }, forward: false };
    if (key === 13) return { key: { kind: "enter" }, forward: false };
    if (key === 27) return { key: { kind: "cancel" }, forward: false };
    if (key === 127) return { key: { kind: "backspace" }, forward: false };
    return { key: { kind: "none" }, forward: false };
  }
  if (params === "200" && finalByte === 0x7e) return { key: { kind: "none" }, forward: false };
  if (params === "201" && finalByte === 0x7e) return { key: { kind: "none" }, forward: false };
  if (finalByte === 0x41) return { key: { kind: "up" }, forward: false };
  if (finalByte === 0x42) return { key: { kind: "down" }, forward: false };
  if (finalByte === 0x7e && (params === "5" || params === "5;1")) return { key: { kind: "up" }, forward: false };
  if (finalByte === 0x7e && (params === "6" || params === "6;1")) return { key: { kind: "down" }, forward: false };
  if (isMouseCsi(params, finalByte)) return { key: { kind: "none" }, forward: false };
  if (isNavigationCsi(finalByte)) return { key: { kind: "none" }, forward: false };
  return { key: { kind: "none" }, forward: true };
}

function applyModalKey(key: ModalKey, state: InputState): StepOutcome {
  if (state.mode === "notifier") {
    if (key.kind === "enter") return notifierResolve(state, true);
    if (key.kind === "cancel") return notifierResolve(state, false);
    if (key.kind === "text" && key.value.toLowerCase() === "n") return notifierResolve(state, false);
    return { state };
  }
  if (state.mode === "executing") {
    if (key.kind === "cancel") return cancelModal(state);
    return { state };
  }
  if (isReadonlyRoute(state.route)) {
    if (key.kind === "enter") return openRoute(state, "home");
    if (key.kind === "cancel") return cancelModal(state);
    if (key.kind === "up" || key.kind === "down") {
      const delta = key.kind === "up" ? -1 : 1;
      const next = Math.max(0, state.viewport.scrollOffset + delta);
      return { state: { ...state, viewport: { ...state.viewport, scrollOffset: next } } };
    }
    return { state };
  }
  if (state.route === "allocation") {
    if (key.kind === "enter") return applyAllocation(state);
    if (key.kind === "cancel") return cancelModal(state);
    if (key.kind === "up" || key.kind === "down") {
      const delta = key.kind === "up" ? -1 : 1;
      const selectedIndex = Math.max(0, Math.min(PRODUCT_PRESET_IDS.length - 1, state.viewport.selectedIndex + delta));
      return { state: { ...state, viewport: { ...state.viewport, selectedIndex } } };
    }
    return { state };
  }
  switch (key.kind) {
    case "enter":
      return submitModalLine(state);
    case "cancel":
      return cancelModal(state);
    case "complete":
      return completeSuggestion(state);
    case "backspace":
      if (state.line.length === 0) return { state };
      return { state: withLine(state, state.line.slice(0, -1)) };
    case "clear":
      return { state: withLine(state, "") };
    case "text":
      return { state: withLine(state, state.line + key.value) };
    case "up":
    case "down": {
      const delta = key.kind === "up" ? -1 : 1;
      const suggestions = commandSuggestions(state.line);
      if (suggestions.length > 0) {
        const max = suggestions.length - 1;
        const suggestionIndex = Math.max(0, Math.min(max, state.suggestionIndex + delta));
        return { state: { ...state, suggestionIndex } };
      }
      const max = Math.max(0, homeCursorLength() - 1);
      const scrollOffset = Math.max(0, Math.min(max, state.viewport.scrollOffset + delta));
      return {
        state: { ...state, viewport: { scrollOffset, selectedIndex: homeSelectedActionIndex(scrollOffset) } },
      };
    }
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
        return {
          state: { ...state, escape: { kind: "string_term" }, heldSeq: [] },
          toPty: Buffer.from(held),
        };
      }
      if (byte === 0x4d) {
        return { state: { ...state, escape: { kind: "legacy_mouse", remaining: 3 }, heldSeq: held } };
      }
      const cleared: InputState = { ...state, escape: null, heldSeq: [] };
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
      const { key, forward } = classifyModalCsi(mode.params, byte, state);
      let inPaste = state.inPaste;
      if (byte === 0x7e && mode.params === "200") inPaste = true;
      if (byte === 0x7e && mode.params === "201") inPaste = false;
      const cleared: InputState = { ...state, escape: null, heldSeq: [], inPaste };
      if (forward) return { state: cleared, toPty: Buffer.from(held) };
      return applyModalKey(key, cleared);
    }

    case "string_term":
      if (byte === 0x03 || byte === state.leaderByte) {
        const hatch = cancelModal({ ...state, escape: null, heldSeq: [] });
        return { state: hatch.state, toPty: Buffer.from([0x1b, 0x5c]), actions: hatch.actions ?? [] };
      }
      if (byte === 0x07) return { state: { ...state, escape: null }, toPty: Buffer.from([byte]) };
      if (byte === 0x1b)
        return { state: { ...state, escape: { kind: "string_term_esc" } }, toPty: Buffer.from([byte]) };
      return { state, toPty: Buffer.from([byte]) };

    case "string_term_esc":
      if (byte === 0x03 || byte === state.leaderByte) {
        const hatch = cancelModal({ ...state, escape: null, heldSeq: [] });
        return { state: hatch.state, toPty: Buffer.from([0x5c]), actions: hatch.actions ?? [] };
      }
      if (byte === 0x5c) return { state: { ...state, escape: null }, toPty: Buffer.from([byte]) };
      return { state: { ...state, escape: { kind: "pending_esc" } }, toPty: Buffer.from([byte]) };

    case "legacy_mouse": {
      const remaining = mode.remaining - 1;
      if (remaining <= 0) return { state: { ...state, escape: null, heldSeq: [] } };
      return { state: { ...state, escape: { kind: "legacy_mouse", remaining }, heldSeq: held } };
    }

    case "csi_candidate":
      return { state: { ...state, escape: null, heldSeq: [] } };
  }
}

function modalByte(byte: number, state: InputState): StepOutcome {
  if (state.escape !== null) return modalEscapeByte(byte, state);

  if (byte === 0x1b) {
    return { state: { ...state, escape: { kind: "pending_esc" }, heldSeq: [byte] } };
  }

  if (state.inPaste) {
    if (byte === 0x03) return cancelModal(state);
    if (state.mode === "modal" && state.route === "home" && byte >= 0x20 && byte <= 0x7e) {
      return { state: withLine(state, state.line + String.fromCharCode(byte)) };
    }
    return { state };
  }

  if (byte === 0x03) {
    return cancelModal(state);
  }

  if (byte === state.leaderByte) {
    return cancelModal(state);
  }

  if (state.mode === "notifier") {
    if (byte === 0x0d || byte === 0x0a) return notifierResolve(state, true);
    if (byte === 0x6e || byte === 0x4e) return notifierResolve(state, false);
    return { state };
  }

  if (state.mode === "executing") return { state };

  if (state.route !== "home") {
    if (byte === 0x0d || byte === 0x0a) return applyModalKey({ kind: "enter" }, state);
    return { state };
  }

  if (byte === 0x0d || byte === 0x0a) return submitModalLine(state);
  if (byte === 0x09) return applyModalKey({ kind: "complete" }, state);
  if (byte === 0x7f || byte === 0x08) return applyModalKey({ kind: "backspace" }, state);
  if (byte === 0x15) {
    return { state: withLine(state, "") };
  }
  if (byte >= 0x20 && byte <= 0x7e) {
    return { state: withLine(state, state.line + String.fromCharCode(byte)) };
  }
  return { state };
}

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

  return { state: current, toPty, actions };
}

export function resolveBareEsc(
  state: InputState,
): { state: InputState; actions: InputAction[]; toPty?: Buffer } | null {
  if (state.mode === "passthrough") {
    if (state.heldSeq.length === 0) return null;
    if (state.escape?.kind === "pending_esc") {
      return { state: { ...state, heldSeq: [] }, actions: [], toPty: Buffer.from(state.heldSeq) };
    }
    if (state.escape?.kind === "csi_candidate") {
      return {
        state: { ...state, escape: { kind: "csi", params: state.escape.params }, heldSeq: [] },
        actions: [],
        toPty: Buffer.from(state.heldSeq),
      };
    }
    return null;
  }
  if (state.escape?.kind !== "pending_esc") return null;
  const cleared: InputState = { ...state, escape: null, heldSeq: [] };
  const cancelled = cancelModal(cleared);
  return { state: cancelled.state, actions: cancelled.actions ?? [] };
}
