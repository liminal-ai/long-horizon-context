import {
  AuthStorage,
  createAgentSessionRuntime,
  type ExtensionFactory,
  getAgentDir,
  InteractiveMode,
  ModelRegistry,
  parseArgs,
  runPrintMode,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import type { ThreadRef } from "lhc";
import { createDeterministicInferenceCallbacks, type SdkConfig } from "lhc";
import activate from "../index.js";
import { setLauncherOwnedStartup } from "../lifecycle/launcher-startup.js";
import type { ThreadChoice } from "../lifecycle/picker.js";
import { preparePrintPrompt, readPipedStdin, resolveAppMode, toPrintOutputMode } from "./app-mode.js";
import { printLauncherListModels } from "./list-models.js";
import {
  extensionFlagValuesFromLaunch,
  launcherHelpText,
  parseLauncherArgv,
  piSessionFlagsConflict,
} from "./parse-args.js";
import { createLauncherRuntimeFactory } from "./runtime-factory.js";
import { prepareLhcLauncherStartup } from "./startup.js";
import { unsupportedLauncherFlagError } from "./unsupported-flags.js";

export { unsupportedLauncherFlagError as deferredUnsupportedLauncherOptions } from "./unsupported-flags.js";

export interface RunPiLhcLauncherDeps {
  cwd?: string;
  registryPath?: string;
  newThreadFilePath?: () => string;
  buildSdkConfig?: () => SdkConfig;
  selectThread?: (choices: readonly ThreadChoice[]) => Promise<string | null>;
}

const piLhcExtension: ExtensionFactory = (pi) => {
  activate(pi as unknown as Parameters<typeof activate>[0]);
};

function resolvedThreadId(ref: ThreadChoice | ThreadRef | { threadId?: string } | undefined): string | null {
  if (ref === undefined || ref === null) return null;
  if (!("threadId" in ref)) return null;
  return typeof ref.threadId === "string" && ref.threadId !== "" ? ref.threadId : null;
}

function announceThreadId(threadId: string | null): void {
  if (threadId === null || threadId === "") return;
  console.error(`LHC thread: ${threadId}`);
}

function applyOfflineMode(offline: boolean | undefined): void {
  if (offline) {
    process.env.PI_OFFLINE = "1";
  }
}

/**
 * Launcher-owned PI startup: resolve LHC thread, seed in-memory PI session from
 * `threadView.getSessionThreadView`, hand thread identity to the connector, then
 * run PI interactively or in print/json mode.
 */
export async function runPiLhcLauncher(argv: readonly string[], deps: RunPiLhcLauncherDeps = {}): Promise<number> {
  const parsedLauncher = parseLauncherArgv(argv);
  if (!parsedLauncher.launchRead.ok) {
    console.error(`Error: ${parsedLauncher.launchRead.error.reason}`);
    return 1;
  }

  const parsed = parseArgs(parsedLauncher.piArgv);

  if (parsedLauncher.showLauncherHelp || parsed.help) {
    console.log(launcherHelpText());
    return 0;
  }

  if (parsed.version) {
    console.log(`pi-lhc ${VERSION}`);
    return 0;
  }

  const blockedPiFlag = piSessionFlagsConflict(parsedLauncher.piArgv);
  if (blockedPiFlag !== null) {
    console.error(`Error: pi-lhc owns LHC startup; do not use PI ${blockedPiFlag} on this path`);
    return 1;
  }

  const appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);

  const unsupported = unsupportedLauncherFlagError(parsed);
  if (unsupported !== null) {
    console.error(`Error: ${unsupported}`);
    return 1;
  }

  if (parsed.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
    for (const diagnostic of parsed.diagnostics) {
      if (diagnostic.type === "error") console.error(`Error: ${diagnostic.message}`);
    }
    return 1;
  }

  applyOfflineMode(parsed.offline);

  if (appMode === "rpc") {
    console.error("Error: --mode rpc is not supported on the pi-lhc launcher");
    return 1;
  }

  if (parsed.listModels !== undefined) {
    const cwd = deps.cwd ?? process.cwd();
    const agentDir = getAgentDir();
    const authStorage = AuthStorage.create();
    SettingsManager.create(cwd, agentDir);
    const modelRegistry = ModelRegistry.create(authStorage);
    const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
    printLauncherListModels(modelRegistry, searchPattern);
    return 0;
  }

  const cwd = deps.cwd ?? process.cwd();
  if (deps.newThreadFilePath === undefined) {
    console.error("Error: launcher requires newThreadFilePath for new-thread startup");
    return 1;
  }

  const launchFlags = parsedLauncher.launchRead.value;
  const startup = await prepareLhcLauncherStartup({
    cwd,
    launchFlags,
    newThreadFilePath: deps.newThreadFilePath,
    sdkConfig: deps.buildSdkConfig?.() ?? {
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
      mode: "background",
    },
    ...(deps.registryPath === undefined ? {} : { registryPath: deps.registryPath }),
    ...(deps.selectThread === undefined ? {} : { selectThread: deps.selectThread }),
  });
  if (!startup.ok) {
    console.error(`Error: ${startup.error.reason}`);
    return 1;
  }
  const threadId = resolvedThreadId(startup.value.threadRef);

  setLauncherOwnedStartup({
    threadRef: startup.value.threadRef,
    launchFlags,
  });

  const agentDir = getAgentDir();
  const extensionFlagValues = extensionFlagValuesFromLaunch(launchFlags);
  for (const [name, value] of parsed.unknownFlags) {
    extensionFlagValues.set(name, value);
  }

  const authStorage = AuthStorage.create();
  const createRuntime = createLauncherRuntimeFactory({
    authStorage,
    extensionFlagValues,
    extensionFactories: [piLhcExtension],
    parsed,
  });

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: startup.value.sessionManager,
    sessionStartEvent: { type: "session_start", reason: "startup" },
  });

  const flagDiagnostics = runtime.diagnostics.filter((diagnostic) => diagnostic.type === "error");
  if (flagDiagnostics.length > 0) {
    for (const diagnostic of flagDiagnostics) {
      console.error(`Error: ${diagnostic.message}`);
    }
    return 1;
  }

  if (!runtime.session.model) {
    console.error("Error: no model available — configure PI auth/models before starting pi-lhc");
    return 1;
  }

  if (appMode === "interactive") {
    const interactiveMode = new InteractiveMode(runtime, {
      ...(parsed.verbose === undefined ? {} : { verbose: parsed.verbose }),
    });
    await interactiveMode.run();
    announceThreadId(threadId);
    return 0;
  }

  const stdinContent = await readPipedStdin();
  const { initialMessage, messages } = preparePrintPrompt(parsed, stdinContent);
  if (appMode === "print" && threadId !== null) {
    process.stdout.write(`${threadId}\n`);
  }
  const exitCode = await runPrintMode(runtime, {
    mode: toPrintOutputMode(appMode),
    messages,
    ...(initialMessage === undefined ? {} : { initialMessage }),
  });
  if (appMode !== "print") {
    announceThreadId(threadId);
  }
  return exitCode;
}

/** @deprecated Use launcher-owned startup via `runPiLhcLauncher`; retained for tests. */
export function piLhcExtensionEntryPath(): string {
  return new URL("../index.js", import.meta.url).pathname;
}
