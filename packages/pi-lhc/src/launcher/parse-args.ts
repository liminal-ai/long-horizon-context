import type { OpResult } from "lhc";
import {
  getFlagFromValues,
  LHC_FLAG_CONTINUE,
  LHC_FLAG_RESUME,
  LHC_FLAG_THREAD,
  readLhcLaunchFlags,
} from "../lifecycle/lhc-launch-flags.js";
import type { LaunchFlags } from "../lifecycle/thread-resolution.js";

export interface ParsedLauncherArgv {
  launchRead: OpResult<LaunchFlags>;
  /** argv with explicit `--lhc-*` flags removed for PI `parseArgs`. */
  piArgv: string[];
  showLauncherHelp: boolean;
}

function flagValuesFromLaunch(launch: LaunchFlags): Record<string, boolean | string> {
  const values: Record<string, boolean | string> = {};
  if (launch.thread !== undefined) values[LHC_FLAG_THREAD] = launch.thread;
  if (launch.resume === true) values[LHC_FLAG_RESUME] = true;
  if (launch.continue === true) values[LHC_FLAG_CONTINUE] = true;
  return values;
}

/** Build extension flag values PI should pass through to registered extension flags. */
export function extensionFlagValuesFromLaunch(launch: LaunchFlags): Map<string, boolean | string> {
  const values = flagValuesFromLaunch(launch);
  const map = new Map<string, boolean | string>();
  for (const [name, value] of Object.entries(values)) {
    map.set(name, value);
  }
  return map;
}

function readStringFlag(argv: string[], index: number): { value: string; nextIndex: number } | null {
  const arg = argv[index];
  if (arg === undefined) return null;
  const eq = arg.indexOf("=");
  if (eq >= 0) {
    const value = arg.slice(eq + 1);
    return value !== "" ? { value, nextIndex: index } : null;
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("-")) return null;
  return { value: next, nextIndex: index + 1 };
}

/**
 * Parse explicit `--lhc-*` flags in the launcher path and return argv suitable for PI.
 * LHC thread attach flags are consumed here so PI native `--session` / `--resume` /
 * `--continue` are not overloaded for LHC startup.
 */
export function parseLauncherArgv(argv: readonly string[]): ParsedLauncherArgv {
  const launch: LaunchFlags = {};
  const piArgv: string[] = [];
  let showLauncherHelp = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--help" || arg === "-h") {
      showLauncherHelp = true;
      piArgv.push(arg);
      continue;
    }

    if (arg === "--lhc-help") {
      showLauncherHelp = true;
      continue;
    }

    if (arg === `--${LHC_FLAG_RESUME}`) {
      launch.resume = true;
      continue;
    }

    if (arg === `--${LHC_FLAG_CONTINUE}`) {
      launch.continue = true;
      continue;
    }

    if (arg === `--${LHC_FLAG_THREAD}` || arg.startsWith(`--${LHC_FLAG_THREAD}=`)) {
      const parsed = readStringFlag(argv as string[], i);
      if (parsed === null) {
        return {
          launchRead: {
            ok: false,
            error: {
              errorClass: "caller_error",
              code: "conflicting_lhc_launch_flags",
              reason: `--${LHC_FLAG_THREAD} requires a thread id value`,
            },
          },
          piArgv,
          showLauncherHelp: false,
        };
      }
      launch.thread = parsed.value;
      i = parsed.nextIndex;
      continue;
    }

    piArgv.push(arg);
  }

  const launchRead = readLhcLaunchFlags(getFlagFromValues(flagValuesFromLaunch(launch)));
  return { launchRead, piArgv, showLauncherHelp };
}

/** PI-native session persistence flags must not compete with LHC launch flags on this path. */
export function piSessionFlagsConflict(piArgv: readonly string[]): string | null {
  const blockedLong = [
    { flag: "session", label: "--session" },
    { flag: "session-id", label: "--session-id" },
    { flag: "session-dir", label: "--session-dir" },
    { flag: "continue", label: "--continue" },
    { flag: "resume", label: "--resume" },
    { flag: "fork", label: "--fork" },
  ] as const;

  for (const arg of piArgv) {
    if (arg === "-c") return "--continue";
    if (arg === "-r") return "--resume";
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const name = body.includes("=") ? body.slice(0, body.indexOf("=")) : body;
    for (const entry of blockedLong) {
      if (name === entry.flag) return entry.label;
    }
  }
  return null;
}

export function launcherHelpText(): string {
  return [
    "pi-lhc — PI with LHC-owned startup context",
    "",
    "Usage:",
    "  pi-lhc [LHC flags] [PI runtime flags]",
    "",
    "LHC thread flags (resolve before PI session creation):",
    "  --lhc-thread <id>     Attach to an LHC thread by full or partial id",
    "  --lhc-resume          Cwd-scoped picker over registry threads",
    "  --lhc-continue        Attach to the most recently created LHC thread",
    "  --lhc-band-percentages <f,s,d,b>",
    "                        Session compact band mix (default 25,25,25,25)",
    "  --lhc-help            Show this help",
    "",
    "Supported PI runtime/config flags:",
    "  --provider <name>              Provider name",
    "  --model <pattern>              Model pattern or provider/model id",
    "  --api-key <key>                Runtime API key (requires --model)",
    "  --thinking <level>             off, minimal, low, medium, high, xhigh",
    "  --tools, -t <names>            Comma-separated tool allowlist",
    "  --exclude-tools, -xt <names>   Comma-separated tool denylist",
    "  --no-tools, -nt                  Disable all tools",
    "  --no-builtin-tools, -nbt         Disable built-in tools only",
    "  --system-prompt <text>           Replace the system prompt",
    "  --append-system-prompt <text>    Append to the system prompt (repeatable)",
    "  --extension, -e <path>           Load an extension (repeatable)",
    "  --no-extensions, -ne             Disable extension discovery",
    "  --skill <path>                   Load a skill (repeatable)",
    "  --no-skills, -ns                 Disable skills discovery",
    "  --prompt-template <path>         Load a prompt template (repeatable)",
    "  --no-prompt-templates, -np       Disable prompt template discovery",
    "  --theme <path>                   Load a theme (repeatable)",
    "  --no-themes                      Disable theme discovery",
    "  --no-context-files, -nc          Disable AGENTS.md / CLAUDE.md loading",
    "  --approve, -a                    Trust project-local files for this run",
    "  --no-approve, -na                Ignore project-local files for this run",
    "  --offline                        Disable startup network operations",
    "  --verbose                        Force verbose startup",
    "  --name, -n <name>                Set session display name",
    "  --print, -p [message]            Single-shot text output (non-interactive)",
    "  --mode json [message]            Single-shot JSON event output",
    "  --list-models [search]           List available models and exit",
    "  --help, -h                       Show this help",
    "  --version, -v                    Show version",
    "",
    "Print/json modes accept positional prompt messages and piped stdin.",
    "",
    "Blocked PI session-source flags (use LHC thread flags instead):",
    "  --session, --session-id, --session-dir, --resume, -r, --continue, -c, --fork",
    "",
    "Unsupported on the pi-lhc launcher (fail loud):",
    "  --mode rpc, --models, --export, @file args, --no-session",
    "  positional prompts in interactive mode (use --print or --mode json)",
    "",
    "Thread attach modes are mutually exclusive. Context is seeded from LHC via an in-memory PI session.",
  ].join("\n");
}
