const LHC_PREFIX = "/lhc";
const BACKSPACE_ECHO = "\x08 \x08";

export type EscapePassthrough =
  | { kind: "pending_esc" }
  | { kind: "csi"; params: string }
  | { kind: "string_term" }
  | { kind: "string_term_esc" }
  | { kind: "legacy_mouse"; remaining: number };

export interface InterceptState {
  /**
   * Shadow count of characters sitting in the child's input box. 0 means the
   * line is fresh and a leading `/` may arm interception. Printables and
   * UTF-8 lead bytes increment; backspace/DEL decrement (floor 0); Enter and
   * ctrl-U zero; a bare Esc zeroes unconditionally. The Esc-zero is a
   * deliberate recovery affordance, NOT box mirroring: Claude Code 2.1.202
   * keeps its input-box text on Esc (probed live), and the box can also fill
   * behind our back (up-arrow history recall is a CSI we pass through
   * uncounted). After either, a /lhc command can arm while a draft sits
   * visibly in the box — the command still dispatches, the draft stays put,
   * and a later bare Enter submits that draft. That trade is accepted so the
   * user is never locked out of /lhc-* until the next submitted turn.
   */
  shadowLen: number;
  withholding: boolean;
  buffer: string;
  /** After dispatching on \\r, swallow exactly one following \\n (CRLF). */
  swallowLfAfterDispatch: boolean;
  /** Mid-sequence escape passthrough (terminal mouse/focus noise). */
  escapePassthrough: EscapePassthrough | null;
  /** Inside a bracketed paste (CSI 200~ … 201~): newlines are literal box content, not submits. */
  inPaste: boolean;
}

export interface InterceptResult {
  state: InterceptState;
  toPty: Buffer;
  toStdout: string;
  /** Full command line (e.g. "/lhc-status") when Enter submits a dispatchable /lhc command. */
  dispatch?: string;
}

type ByteOutcome = InterceptResult & { consumedRest?: boolean };

export function createInterceptState(): InterceptState {
  return {
    shadowLen: 0,
    withholding: false,
    buffer: "",
    swallowLfAfterDispatch: false,
    escapePassthrough: null,
    inPaste: false,
  };
}

/** True while the shadow buffer should stay withheld from the pty. */
export function isWithholdBuffer(buffer: string): boolean {
  if (buffer === LHC_PREFIX || buffer.startsWith(LHC_PREFIX)) return true;
  return LHC_PREFIX.startsWith(buffer);
}

function isDispatchableLhcCommand(buffer: string): boolean {
  return buffer === LHC_PREFIX || buffer.startsWith(`${LHC_PREFIX}-`);
}

/**
 * Key code of a kitty CSI-u keypress (press or repeat), or null for release
 * events and unparseable params. Format: code[:alts];modifiers[:event];text —
 * event 3 is a release and must not touch the shadow count twice.
 */
function kittyKeyPressCode(params: string): number | null {
  const fields = params.split(";");
  const code = Number.parseInt(fields[0] ?? "", 10);
  if (!Number.isFinite(code)) return null;
  const event = fields[1]?.split(":")[1];
  if (event === "3") return null;
  return code;
}

function resetState(state: InterceptState): InterceptState {
  return { ...createInterceptState(), inPaste: state.inPaste };
}

function byteToChar(byte: number): string {
  return String.fromCharCode(byte);
}

function isCsiFinal(byte: number): boolean {
  return byte >= 0x40 && byte <= 0x7e;
}

/** Printable ASCII or a UTF-8 lead byte — one new character in the child's input box. */
function countsAsChar(byte: number): boolean {
  return (byte >= 0x20 && byte <= 0x7e) || byte >= 0xc0;
}

/**
 * Shadow count after bytes are forwarded raw (flush/cancel paths that skip
 * per-byte processing). Escape sequences inside the bytes tally their
 * printable characters, so this can only overcount — the safe direction; a
 * bare Esc re-zeroes.
 */
function shadowLenAfterRaw(bytes: Buffer, inPaste: boolean): number {
  let len = 0;
  for (const byte of bytes) {
    if (byte === 0x0d || byte === 0x0a) len = inPaste ? len + 1 : 0;
    else if (byte === 0x15) len = 0;
    else if (byte === 0x7f || byte === 0x08) len = Math.max(0, len - 1);
    else if (countsAsChar(byte)) len += 1;
  }
  return len;
}

function eraseEchoed(charCount: number): string {
  if (charCount <= 0) return "";
  return BACKSPACE_ECHO.repeat(charCount);
}

function passthroughByte(byte: number, state: InterceptState): ByteOutcome {
  return {
    state,
    toPty: Buffer.from([byte]),
    toStdout: "",
  };
}

function flushWithheldAndRemainder(
  state: InterceptState,
  chunk: Buffer,
  fromIndex: number,
): ByteOutcome {
  const flushed = Buffer.concat([Buffer.from(state.buffer, "utf8"), chunk.subarray(fromIndex)]);
  return {
    state: {
      shadowLen: shadowLenAfterRaw(flushed, state.inPaste),
      withholding: false,
      buffer: "",
      swallowLfAfterDispatch: false,
      escapePassthrough: null,
      inPaste: state.inPaste,
    },
    toPty: flushed,
    toStdout: eraseEchoed(state.buffer.length),
    consumedRest: true,
  };
}

function cancelWithheldBareEsc(state: InterceptState, chunk: Buffer, fromIndex: number): ByteOutcome {
  // Esc zeroed the child's (empty) input box; the withheld buffer is dropped,
  // so only the raw-forwarded remainder can put characters in the box.
  const remainder = chunk.subarray(fromIndex);
  return {
    state: {
      shadowLen: shadowLenAfterRaw(remainder, state.inPaste),
      withholding: false,
      buffer: "",
      swallowLfAfterDispatch: false,
      escapePassthrough: null,
      inPaste: state.inPaste,
    },
    toPty: remainder,
    toStdout: eraseEchoed(state.buffer.length),
    consumedRest: true,
  };
}

function cancelWithheldBareEscAtEnd(state: InterceptState): { state: InterceptState; toStdout: string } {
  return {
    state: resetState(state),
    toStdout: eraseEchoed(state.buffer.length),
  };
}

function stateAfterDispatch(state: InterceptState): InterceptState {
  return { ...resetState(state), swallowLfAfterDispatch: true };
}

function dispatchWithheldCommand(state: InterceptState): ByteOutcome {
  return {
    state: stateAfterDispatch(state),
    toPty: Buffer.alloc(0),
    toStdout: "\r\n",
    dispatch: state.buffer,
  };
}

function isStringTermIntroducer(byte: number): boolean {
  return byte === 0x5d || byte === 0x50 || byte === 0x5e || byte === 0x5f || byte === 0x58;
}

function continueEscapePassthrough(
  byte: number,
  state: InterceptState,
  chunk: Buffer,
  index: number,
): ByteOutcome {
  const mode = state.escapePassthrough;
  if (mode === null) {
    return passthroughByte(byte, state);
  }

  const base: InterceptState = { ...state, escapePassthrough: null };

  switch (mode.kind) {
    case "pending_esc":
      if (byte === 0x5b) {
        return {
          state: { ...state, escapePassthrough: { kind: "csi", params: "" } },
          toPty: Buffer.from([byte]),
          toStdout: "",
        };
      }
      if (isStringTermIntroducer(byte)) {
        return { state: { ...state, escapePassthrough: { kind: "string_term" } }, toPty: Buffer.from([byte]), toStdout: "" };
      }
      if (byte === 0x4d) {
        return {
          state: { ...state, escapePassthrough: { kind: "legacy_mouse", remaining: 3 } },
          toPty: Buffer.from([byte]),
          toStdout: "",
        };
      }
      if (state.withholding) {
        return cancelWithheldBareEsc(state, chunk, index);
      }
      // Esc + non-sequence byte in one chunk is Alt-key/terminal noise, not a
      // bare Esc keypress (those arrive as a lone \x1b chunk) — forward both
      // without touching the shadow count.
      return { state: base, toPty: Buffer.from([byte]), toStdout: "" };

    case "csi":
      if (isCsiFinal(byte)) {
        if (byte === 0x75) {
          // Kitty CSI-u functional keys mirror onto the shadow count; presses
          // and repeats act, releases (event 3) are ignored for Enter too.
          // The full sequence is forwarded (except a dispatching Enter's final
          // byte): while withholding the child's box is empty, so its
          // Enter/Esc/Backspace land as no-ops there.
          const key = kittyKeyPressCode(mode.params);
          if (key === 13) {
            if (state.withholding) {
              if (isDispatchableLhcCommand(state.buffer)) {
                return dispatchWithheldCommand(state);
              }
              return {
                state: resetState(state),
                toPty: Buffer.from([byte]),
                toStdout: "",
              };
            }
            return { state: { ...base, shadowLen: 0 }, toPty: Buffer.from([byte]), toStdout: "" };
          }
          if (key === 27) {
            if (state.withholding) {
              return {
                state: { ...resetState(state), inPaste: state.inPaste },
                toPty: Buffer.from([byte]),
                toStdout: eraseEchoed(state.buffer.length),
              };
            }
            return { state: { ...base, shadowLen: 0 }, toPty: Buffer.from([byte]), toStdout: "" };
          }
          if (key === 127) {
            if (state.withholding) {
              const nextBuffer = state.buffer.slice(0, -1);
              return {
                state: {
                  ...base,
                  withholding: nextBuffer.length > 0,
                  buffer: nextBuffer,
                },
                toPty: Buffer.from([byte]),
                toStdout: BACKSPACE_ECHO,
              };
            }
            return { state: { ...base, shadowLen: Math.max(0, state.shadowLen - 1) }, toPty: Buffer.from([byte]), toStdout: "" };
          }
        }
        if (byte === 0x7e && mode.params === "200") {
          return { state: { ...base, inPaste: true }, toPty: Buffer.from([byte]), toStdout: "" };
        }
        if (byte === 0x7e && mode.params === "201") {
          return { state: { ...base, inPaste: false }, toPty: Buffer.from([byte]), toStdout: "" };
        }
        return { state: base, toPty: Buffer.from([byte]), toStdout: "" };
      }
      return {
        state: { ...state, escapePassthrough: { kind: "csi", params: mode.params + byteToChar(byte) } },
        toPty: Buffer.from([byte]),
        toStdout: "",
      };

    case "string_term":
      if (byte === 0x07) {
        return { state: base, toPty: Buffer.from([byte]), toStdout: "" };
      }
      if (byte === 0x1b) {
        return { state: { ...state, escapePassthrough: { kind: "string_term_esc" } }, toPty: Buffer.from([byte]), toStdout: "" };
      }
      return { state, toPty: Buffer.from([byte]), toStdout: "" };

    case "string_term_esc":
      if (byte === 0x5c) {
        return { state: base, toPty: Buffer.from([byte]), toStdout: "" };
      }
      return {
        state: { ...state, escapePassthrough: { kind: "pending_esc" } },
        toPty: Buffer.from([byte]),
        toStdout: "",
      };

    case "legacy_mouse": {
      const remaining = mode.remaining - 1;
      if (remaining <= 0) {
        return { state: base, toPty: Buffer.from([byte]), toStdout: "" };
      }
      return {
        state: { ...state, escapePassthrough: { kind: "legacy_mouse", remaining } },
        toPty: Buffer.from([byte]),
        toStdout: "",
      };
    }
  }
}

function beginEscapePassthrough(state: InterceptState): ByteOutcome {
  return {
    state: { ...state, escapePassthrough: { kind: "pending_esc" } },
    toPty: Buffer.from([0x1b]),
    toStdout: "",
  };
}

function processByte(byte: number, state: InterceptState, chunk: Buffer, index: number): ByteOutcome {
  if (state.escapePassthrough !== null) {
    return continueEscapePassthrough(byte, state, chunk, index);
  }

  if (state.swallowLfAfterDispatch) {
    const cleared: InterceptState = { ...state, swallowLfAfterDispatch: false };
    if (byte === 0x0a) {
      return { state: cleared, toPty: Buffer.alloc(0), toStdout: "" };
    }
    return processByte(byte, cleared, chunk, index);
  }

  if (byte === 0x03) {
    // Ctrl-C clears Claude Code's input box; count only the raw-forwarded rest.
    const rest = chunk.subarray(index + 1);
    return {
      state: { ...resetState(state), shadowLen: shadowLenAfterRaw(rest, state.inPaste) },
      toPty: Buffer.concat([Buffer.from([byte]), rest]),
      toStdout: "",
      ...(rest.length > 0 ? { consumedRest: true } : {}),
    };
  }

  if (byte === 0x0d || byte === 0x0a) {
    if (state.inPaste) {
      // A pasted newline is literal input-box content, not a submit — even
      // while withholding: the withheld bytes were retroactively paste
      // content, so flush them (plus this newline) to the pty and stop
      // withholding. Only the buffer is flushed, not the rest of the chunk,
      // so a paste-close marker later in the chunk still parses and clears
      // inPaste.
      if (state.withholding) {
        const flushed = Buffer.from(state.buffer + byteToChar(byte), "utf8");
        return {
          state: {
            ...state,
            withholding: false,
            buffer: "",
            shadowLen: shadowLenAfterRaw(flushed, true),
          },
          toPty: flushed,
          toStdout: eraseEchoed(state.buffer.length),
        };
      }
      return { state: { ...state, shadowLen: state.shadowLen + 1 }, toPty: Buffer.from([byte]), toStdout: "" };
    }
    if (state.withholding) {
      if (isDispatchableLhcCommand(state.buffer)) {
        return {
          state: byte === 0x0d ? stateAfterDispatch(state) : resetState(state),
          toPty: Buffer.alloc(0),
          toStdout: "\r\n",
          dispatch: state.buffer,
        };
      }
      const flushed = Buffer.from(state.buffer + byteToChar(byte), "utf8");
      return {
        state: { ...resetState(state), shadowLen: shadowLenAfterRaw(flushed, state.inPaste) },
        toPty: flushed,
        toStdout: "",
      };
    }
    return {
      state: resetState(state),
      toPty: Buffer.from([byte]),
      toStdout: "",
    };
  }

  if (byte === 0x7f || byte === 0x08) {
    if (state.withholding && state.buffer.length > 0) {
      const nextBuffer = state.buffer.slice(0, -1);
      return {
        state: {
          ...state,
          withholding: nextBuffer.length > 0,
          buffer: nextBuffer,
        },
        toPty: Buffer.alloc(0),
        toStdout: BACKSPACE_ECHO,
      };
    }
    return { state: { ...state, shadowLen: Math.max(0, state.shadowLen - 1) }, toPty: Buffer.from([byte]), toStdout: "" };
  }

  if (byte === 0x15) {
    // Ctrl-U clears the input line.
    if (state.withholding) {
      return flushWithheldAndRemainder(state, chunk, index);
    }
    return { state: { ...state, shadowLen: 0 }, toPty: Buffer.from([byte]), toStdout: "" };
  }

  if (byte === 0x1b) {
    return beginEscapePassthrough(state);
  }

  if (state.withholding) {
    if (byte >= 0x20 && byte <= 0x7e) {
      const nextBuffer = state.buffer + byteToChar(byte);
      if (isWithholdBuffer(nextBuffer)) {
        return {
          state: { ...state, buffer: nextBuffer },
          toPty: Buffer.alloc(0),
          toStdout: byteToChar(byte),
        };
      }
    }
    return flushWithheldAndRemainder(state, chunk, index);
  }

  if (byte === 0x2f && state.shadowLen === 0) {
    return {
      state: { ...state, withholding: true, buffer: "/" },
      toPty: Buffer.alloc(0),
      toStdout: "/",
    };
  }

  if (countsAsChar(byte)) {
    return { state: { ...state, shadowLen: state.shadowLen + 1 }, toPty: Buffer.from([byte]), toStdout: "" };
  }

  // Remaining C0 controls and UTF-8 continuation bytes: forward, no count change.
  return passthroughByte(byte, state);
}

export function processInputChunk(chunk: Buffer, state: InterceptState): InterceptResult {
  let current = state;
  let toPty = Buffer.alloc(0);
  let toStdout = "";
  let dispatch: string | undefined;

  for (let index = 0; index < chunk.length; index += 1) {
    const outcome = processByte(chunk[index]!, current, chunk, index);
    current = outcome.state;
    toPty = Buffer.concat([toPty, outcome.toPty]);
    toStdout += outcome.toStdout;
    if (outcome.dispatch !== undefined) dispatch = outcome.dispatch;
    if (outcome.consumedRest === true) break;
  }

  // A lone \x1b chunk is a bare Esc keypress (sequences arrive with their
  // introducer in the same read). Zero the shadow count: not because Claude
  // Code clears its box on Esc (2.1.202 does not — see the shadowLen doc),
  // but as the guaranteed recovery when the count has drifted. Esc then
  // /lhc-… always arms, even if a draft remains in the box.
  if (
    current.escapePassthrough?.kind === "pending_esc" &&
    chunk.length === 1 &&
    chunk[0] === 0x1b
  ) {
    if (current.withholding) {
      const cancelled = cancelWithheldBareEscAtEnd(current);
      current = cancelled.state;
      toStdout += cancelled.toStdout;
    } else {
      current = { ...current, escapePassthrough: null, shadowLen: 0 };
    }
  }

  const merged: InterceptResult = { state: current, toPty, toStdout };
  if (dispatch !== undefined) merged.dispatch = dispatch;
  return merged;
}
