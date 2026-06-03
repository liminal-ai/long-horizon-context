import { LHC_PACKAGE_NAME, LHC_PACKAGE_VERSION } from "../index.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const HELP_TEXT = `lhc - Long Horizon Context SDK/CLI core

USAGE
  lhc --help
  lhc --version
  lhc thread-events <command> [options]

THREAD EVENT COMMANDS
  lhc thread-events create --event-db <path> [--client-thread-id <id>] [--title "..."]
  lhc thread-events append --event-db <path> --client-thread-id <id> --file <event.json>
  lhc thread-events list --event-db <path> [--json]
  lhc thread-events threads --event-db <path> [--json]
  lhc thread-events read --event-db <path> --client-thread-id <id> [--json]
`;

export async function runCli(argv: readonly string[]): Promise<CliResult> {
  const args = [...argv];
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    return { stdout: HELP_TEXT, stderr: "", exitCode: 0 };
  }

  if (args.includes("--version") || args.includes("-v")) {
    return { stdout: `${LHC_PACKAGE_NAME} ${LHC_PACKAGE_VERSION}\n`, stderr: "", exitCode: 0 };
  }

  const [command, ...rest] = args;
  if (command === "thread-events") {
    const { runThreadEventsCommand } = await import("./thread-events.js");
    return await runThreadEventsCommand(rest);
  }

  return { stdout: "", stderr: `lhc: unknown command: ${command ?? ""}\n\n${HELP_TEXT}`, exitCode: 1 };
}
