import { type OpResult, type ThreadRef, threads } from "lhc";
import { registryArg, threadRefById } from "./thread-resolution.js";

/** One row the picker offers: enough to show the operator what they are
 *  resuming — its title (when set) and creation time — keyed by the id the
 *  selection resolves. */
export interface ThreadChoice {
  threadId: string;
  title?: string;
  createdAt: string;
}

/** What the picker needs from the host: the registry to list/resolve through,
 *  and the selection mechanism. `select` is injected so the picker stays a thin,
 *  headless-safe registry operation — a real UI in production, a deterministic
 *  choice in tests — and returns the chosen thread id, or `null` to cancel. */
export interface PickerDeps {
  registryPath?: string;
  select: (choices: readonly ThreadChoice[]) => Promise<string | null>;
}

/** `--resume`/`-r`: list the current cwd's threads (title + creation time) and
 *  resolve the operator's selection. The cwd scope is the registry query, not a
 *  filter over an unscoped list (anti-shim). With no threads for the cwd the
 *  picker reports an empty list (`null`) rather than failing; a cancelled
 *  selection is likewise `null`. */
export async function pickThread(cwd: string, deps: PickerDeps): Promise<OpResult<ThreadRef | null>> {
  const listed = await threads.listThreads({ cwd, ...registryArg(deps.registryPath) });
  if (!listed.ok) return listed;
  if (listed.value.length === 0) return { ok: true, value: null };

  const choices: ThreadChoice[] = listed.value.map((info) => {
    const choice: ThreadChoice = { threadId: info.threadId, createdAt: info.createdAt };
    if (info.title !== undefined) choice.title = info.title;
    return choice;
  });

  const chosen = await deps.select(choices);
  if (chosen === null) return { ok: true, value: null };

  const resolved = await threads.resolve({ threadId: chosen, ...registryArg(deps.registryPath) });
  if (!resolved.ok) return resolved;
  return { ok: true, value: threadRefById(resolved.value.threadId, deps.registryPath) };
}
