const LHC_PREFIX = "/lhc";
const BACKSPACE_ECHO = "\x08 \x08";

export interface InterceptState {
  freshLine: boolean;
  withholding: boolean;
  buffer: string;
  /** After dispatching on \\r, swallow exactly one following \\n (CRLF). */
  swallowLfAfterDispatch: boolean;
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
  return { freshLine: true, withholding: false, buffer: "", swallowLfAfterDispatch: false };
}

/** True while the shadow buffer should stay withheld from the pty. */
export function isWithholdBuffer(buffer: string): boolean {
  if (buffer === LHC_PREFIX || buffer.startsWith(LHC_PREFIX)) return true;
  return LHC_PREFIX.startsWith(buffer);
}

function isDispatchableLhcCommand(buffer: string): boolean {
  return buffer === LHC_PREFIX || buffer.startsWith(`${LHC_PREFIX}-`);
}

function resetState(): InterceptState {
  return createInterceptState();
}

function byteToChar(byte: number): string {
  return String.fromCharCode(byte);
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

function flushWithheldAndRemainder(withheld: string, chunk: Buffer, fromIndex: number): ByteOutcome {
  return {
    state: { freshLine: false, withholding: false, buffer: "", swallowLfAfterDispatch: false },
    toPty: Buffer.concat([Buffer.from(withheld, "utf8"), chunk.subarray(fromIndex)]),
    toStdout: eraseEchoed(withheld.length),
    consumedRest: true,
  };
}

function stateAfterDispatch(): InterceptState {
  return { freshLine: true, withholding: false, buffer: "", swallowLfAfterDispatch: true };
}

function processByte(byte: number, state: InterceptState, chunk: Buffer, index: number): ByteOutcome {
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

  if (byte === 0x1b && state.withholding) {
    return flushWithheldAndRemainder(state.buffer, chunk, index);
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
        },
        toPty: Buffer.alloc(0),
        toStdout: BACKSPACE_ECHO,
      };
    }
    return passthroughByte(byte, state);
  }

  if (state.withholding && byte < 0x20) {
    return flushWithheldAndRemainder(state.buffer, chunk, index);
  }

  if (state.freshLine && !state.withholding) {
    if (byte === 0x2f) {
      return {
        state: { freshLine: true, withholding: true, buffer: "/", swallowLfAfterDispatch: false },
        toPty: Buffer.alloc(0),
        toStdout: "/",
      };
    }
    return {
      state: { freshLine: false, withholding: false, buffer: "", swallowLfAfterDispatch: false },
      toPty: Buffer.from([byte]),
      toStdout: "",
    };
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

  const merged: InterceptResult = { state: current, toPty, toStdout };
  if (dispatch !== undefined) merged.dispatch = dispatch;
  return merged;
}
