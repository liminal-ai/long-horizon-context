const LHC_PREFIX = "/lhc";
const BACKSPACE_ECHO = "\x08 \x08";

export type EscapePassthrough =
  | { kind: "pending_esc" }
  | { kind: "csi"; params: string }
  | { kind: "osc" }
  | { kind: "osc_esc" }
  | { kind: "legacy_mouse"; remaining: number };

export interface InterceptState {
  freshLine: boolean;
  withholding: boolean;
  buffer: string;
  /** After dispatching on \\r, swallow exactly one following \\n (CRLF). */
  swallowLfAfterDispatch: boolean;
  /** Mid-sequence escape passthrough (terminal mouse/focus noise). */
  escapePassthrough: EscapePassthrough | null;
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
    freshLine: true,
    withholding: false,
    buffer: "",
    swallowLfAfterDispatch: false,
    escapePassthrough: null,
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

function isKittyEnterCsi(params: string): boolean {
  return params === "13" || params.startsWith("13;");
}

function resetState(): InterceptState {
  return createInterceptState();
}

function byteToChar(byte: number): string {
  return String.fromCharCode(byte);
}

function isCsiFinal(byte: number): boolean {
  return byte >= 0x40 && byte <= 0x7e;
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
  withheld: string,
  chunk: Buffer,
  fromIndex: number,
): ByteOutcome {
  return {
    state: { freshLine: false, withholding: false, buffer: "", swallowLfAfterDispatch: false, escapePassthrough: null },
    toPty: Buffer.concat([Buffer.from(withheld, "utf8"), chunk.subarray(fromIndex)]),
    toStdout: eraseEchoed(withheld.length),
    consumedRest: true,
  };
}

function cancelWithheldBareEsc(state: InterceptState, chunk: Buffer, fromIndex: number): ByteOutcome {
  return {
    state: { freshLine: false, withholding: false, buffer: "", swallowLfAfterDispatch: false, escapePassthrough: null },
    toPty: chunk.subarray(fromIndex),
    toStdout: eraseEchoed(state.buffer.length),
    consumedRest: true,
  };
}

function cancelWithheldBareEscAtEnd(state: InterceptState): { state: InterceptState; toStdout: string } {
  return {
    state: { freshLine: false, withholding: false, buffer: "", swallowLfAfterDispatch: false, escapePassthrough: null },
    toStdout: eraseEchoed(state.buffer.length),
  };
}

function stateAfterDispatch(): InterceptState {
  return { freshLine: true, withholding: false, buffer: "", swallowLfAfterDispatch: true, escapePassthrough: null };
}

function dispatchWithheldCommand(state: InterceptState): ByteOutcome {
  return {
    state: stateAfterDispatch(),
    toPty: Buffer.alloc(0),
    toStdout: "\r\n",
    dispatch: state.buffer,
  };
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
      if (byte === 0x5d) {
        return { state: { ...state, escapePassthrough: { kind: "osc" } }, toPty: Buffer.from([byte]), toStdout: "" };
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
      return { state: base, toPty: Buffer.from([byte]), toStdout: "" };

    case "csi":
      if (isCsiFinal(byte)) {
        if (byte === 0x75 && isKittyEnterCsi(mode.params) && state.withholding) {
          if (isDispatchableLhcCommand(state.buffer)) {
            return dispatchWithheldCommand(state);
          }
          return {
            state: resetState(),
            toPty: Buffer.from([byte]),
            toStdout: "",
          };
        }
        return { state: base, toPty: Buffer.from([byte]), toStdout: "" };
      }
      return {
        state: { ...state, escapePassthrough: { kind: "csi", params: mode.params + byteToChar(byte) } },
        toPty: Buffer.from([byte]),
        toStdout: "",
      };

    case "osc":
      if (byte === 0x07) {
        return { state: base, toPty: Buffer.from([byte]), toStdout: "" };
      }
      if (byte === 0x1b) {
        return { state: { ...state, escapePassthrough: { kind: "osc_esc" } }, toPty: Buffer.from([byte]), toStdout: "" };
      }
      return { state, toPty: Buffer.from([byte]), toStdout: "" };

    case "osc_esc":
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
    const rest = chunk.subarray(index + 1);
    return {
      state: resetState(),
      toPty: Buffer.concat([Buffer.from([byte]), rest]),
      toStdout: "",
      ...(rest.length > 0 ? { consumedRest: true } : {}),
    };
  }

  if (byte === 0x0d || byte === 0x0a) {
    if (state.withholding) {
      if (isDispatchableLhcCommand(state.buffer)) {
        return {
          state: byte === 0x0d ? stateAfterDispatch() : resetState(),
          toPty: Buffer.alloc(0),
          toStdout: "\r\n",
          dispatch: state.buffer,
        };
      }
      return {
        state: resetState(),
        toPty: Buffer.from(state.buffer + byteToChar(byte), "utf8"),
        toStdout: "",
      };
    }
    return {
      state: resetState(),
      toPty: Buffer.from([byte]),
      toStdout: "",
    };
  }

  if (byte === 0x7f) {
    if (state.withholding && state.buffer.length > 0) {
      const nextBuffer = state.buffer.slice(0, -1);
      return {
        state: {
          freshLine: true,
          withholding: nextBuffer.length > 0,
          buffer: nextBuffer,
          swallowLfAfterDispatch: false,
          escapePassthrough: null,
        },
        toPty: Buffer.alloc(0),
        toStdout: BACKSPACE_ECHO,
      };
    }
    return passthroughByte(byte, state);
  }

  if (byte === 0x1b) {
    return beginEscapePassthrough(state);
  }

  if (state.withholding && byte < 0x20) {
    return flushWithheldAndRemainder(state.buffer, chunk, index);
  }

  if (state.freshLine && !state.withholding) {
    if (byte === 0x2f) {
      return {
        state: { freshLine: true, withholding: true, buffer: "/", swallowLfAfterDispatch: false, escapePassthrough: null },
        toPty: Buffer.alloc(0),
        toStdout: "/",
      };
    }
    if (byte >= 0x20 && byte <= 0x7e) {
      return {
        state: { freshLine: false, withholding: false, buffer: "", swallowLfAfterDispatch: false, escapePassthrough: null },
        toPty: Buffer.from([byte]),
        toStdout: "",
      };
    }
    return passthroughByte(byte, state);
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
      return flushWithheldAndRemainder(state.buffer, chunk, index);
    }
    return flushWithheldAndRemainder(state.buffer, chunk, index);
  }

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

  if (
    current.escapePassthrough?.kind === "pending_esc" &&
    current.withholding &&
    chunk.length === 1 &&
    chunk[0] === 0x1b
  ) {
    const cancelled = cancelWithheldBareEscAtEnd(current);
    current = cancelled.state;
    toStdout += cancelled.toStdout;
  }

  const merged: InterceptResult = { state: current, toPty, toStdout };
  if (dispatch !== undefined) merged.dispatch = dispatch;
  return merged;
}
