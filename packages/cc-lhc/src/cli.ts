import { isLhcVersionArgv, parseWrapperArgv } from "./cli-args.js";
import { isBackfillLabelsArgv, runBackfillLabelsCli } from "./commands/backfill-labels.js";
import { isTasksArgv, runTasksCli } from "./continuity/tasks-cli.js";
import { CC_LHC_HELP, isLhcHelpArgv } from "./help.js";
import { isRetrievalArgv, runRetrievalCli } from "./retrieval/service.js";
import { formatLhcVersion, readBuildIdentity } from "./version.js";
import { isPreviewArgv, runPreviewCli } from "./wrapper/preview.js";
import { run } from "./wrapper/run.js";

const rawArgv = process.argv.slice(2);

// Model-callable retrieval ops: bound descriptor selects the archive.
// These never open the PTY wrapper. Do not process.exit here — set exitCode
// so Node can drain stdout after the awaited flush-safe write.
if (isLhcVersionArgv(rawArgv)) {
  // CC-LHC identity only; never launches Claude (TC-3.1a).
  process.stdout.write(`${formatLhcVersion(readBuildIdentity())}\n`);
} else if (isLhcHelpArgv(rawArgv)) {
  process.stdout.write(`${CC_LHC_HELP}\n`);
} else if (isBackfillLabelsArgv(rawArgv)) {
  // Operator-facing label backfill: explicit thread, no PTY, no descriptor.
  const exitCode = await runBackfillLabelsCli(rawArgv).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    return 1;
  });
  process.exitCode = exitCode;
} else if (isTasksArgv(rawArgv)) {
  // Model-callable carried-work management (LIM-146): same descriptor binding as retrieval.
  const exitCode = await runTasksCli(rawArgv).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    return 1;
  });
  process.exitCode = exitCode;
} else if (isPreviewArgv(rawArgv)) {
  // Developer-facing first-load panel preview (D12): production renderer,
  // disposable home, never launches Claude.
  process.exitCode = runPreviewCli(rawArgv, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
} else if (isRetrievalArgv(rawArgv)) {
  const exitCode = await runRetrievalCli(rawArgv).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    return 1;
  });
  process.exitCode = exitCode;
} else {
  const result = parseWrapperArgv(rawArgv);
  if (!result.ok) {
    console.error(result.message);
    process.exit(2);
  }
  const parsed = result.parsed;
  const hasOverrides = Object.keys(parsed.contextPolicyOverrides).length > 0;

  const exitCode = await run(parsed.claudeArgv, {
    noInference: parsed.noInference,
    ...(parsed.notifierDisabled ? { notifierDisabled: true } : {}),
    ...(hasOverrides ? { contextPolicyOverrides: parsed.contextPolicyOverrides } : {}),
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    return 1;
  });

  // Wrapper path may need force-exit for PTY lifecycle; retrieval does not.
  process.exit(exitCode);
}
