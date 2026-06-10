import type { ErrorClass, OpResult } from "../shared/errors.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Adapter-level failures (unknown command, missing command) happen before any
// SDK call, so they carry adapter codes outside the SDK's ErrorCode set while
// keeping the same structural shape.
export type CliErrorCode = "unknown_command" | "missing_flag";

export function renderResult(result: OpResult<unknown>): CliResult {
  return {
    exitCode: result.ok ? 0 : 1,
    stdout: `${JSON.stringify(result, null, 2)}\n`,
    stderr: "",
  };
}

export function renderCliError(
  errorClass: ErrorClass,
  code: CliErrorCode,
  reason: string,
): CliResult {
  return {
    exitCode: 1,
    stdout: `${JSON.stringify({ ok: false, error: { errorClass, code, reason } }, null, 2)}\n`,
    stderr: "",
  };
}
