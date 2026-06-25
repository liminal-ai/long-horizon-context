import { createInterface } from "node:readline";
import type { OpResult, ThreadRef } from "lhc";
import { pickThread, type ThreadChoice } from "../lifecycle/picker.js";
import type { LaunchFlags, ResolveDeps } from "../lifecycle/thread-resolution.js";
import { resolveThread } from "../lifecycle/thread-resolution.js";

function renderResumeCandidates(choices: readonly ThreadChoice[]): string {
  const lines = choices.map((choice, index) => {
    const title = choice.title ?? "(untitled)";
    return `  ${index + 1}. ${title}  ·  created ${choice.createdAt}  ·  ${choice.threadId}`;
  });
  return [
    `pi-lhc --lhc-resume: ${choices.length} thread(s) in this directory:`,
    ...lines,
    "Enter a number, or relaunch with --lhc-thread <id>.",
  ].join("\n");
}

async function promptResumeChoice(choices: readonly ThreadChoice[]): Promise<string | null> {
  if (choices.length === 0) return null;
  if (choices.length === 1) return choices[0]?.threadId ?? null;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;

  console.log(renderResumeCandidates(choices));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question("Select thread: ", resolve));
    const index = Number.parseInt(answer.trim(), 10);
    if (!Number.isFinite(index) || index < 1 || index > choices.length) return null;
    return choices[index - 1]?.threadId ?? null;
  } finally {
    rl.close();
  }
}

/** Resolve the LHC recording thread before PI session creation. */
export async function resolveStartupThread(
  launch: LaunchFlags,
  deps: ResolveDeps,
): Promise<OpResult<ThreadRef | null>> {
  if (launch.resume === true) {
    return pickThread(deps.cwd, {
      ...(deps.registryPath === undefined ? {} : { registryPath: deps.registryPath }),
      select: promptResumeChoice,
    });
  }
  return resolveThread(launch, deps);
}
