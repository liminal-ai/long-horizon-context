import { basename } from "node:path";
import { type OpResult, type ThreadRef, threads } from "lhc";

// Launch flags name the thread; the registry resolves it. PI's own session
// file still exists, but it is not where thread identity lives.

/** None set → new thread. (`--lhc-resume` is owned by the picker, routed
 *  before this resolver — see `picker.ts`.) */
export interface LaunchFlags {
  resume?: boolean; // --lhc-resume : cwd-scoped picker (handled by picker.ts)
  continue?: boolean; // --lhc-continue : most recent
  thread?: string; // --lhc-thread <id> : full or partial id
}

/** What the resolver needs from the host beyond the launch flags: the cwd a new
 *  thread is registered under, the registry to resolve through, and where a new
 *  thread's file is created. Injected so the resolver is exercised against a
 *  real temp registry in tests and the production `~/.pi-lhc` registry when the
 *  entry point fills it — `registryPath` is a per-operation argument, never an
 *  `initLhc` config field. */
export interface ResolveDeps {
  cwd: string;
  registryPath?: string;
  newThreadFilePath: () => string;
  /** Title for a newly created thread (A-8 title metadata). Defaults to
   *  `defaultThreadTitle(cwd)` so every connector-created thread is titled.
   *  A host may override it. */
  newThreadTitle?: string;
}

/** The creation-time title for a new thread when the host supplies none. At
 *  session_start there is no first prompt yet, so the title is the cwd's leaf
 *  directory name — a real, non-empty project label the `--lhc-resume` picker shows
 *  alongside the creation time. Prompt-derived titles are the deferred TDQ Q4. */
export function defaultThreadTitle(cwd: string): string {
  const leaf = basename(cwd);
  if (leaf !== "") return leaf;
  return cwd !== "" ? cwd : "lhc session";
}

/** The durable, plain-data thread reference the connector retains and
 *  reattaches from: a thread id (plus the registry it lives in), not a live
 *  object. `{ filePath }` is avoided so reload reconstructs by id. */
export function threadRefById(threadId: string, registryPath?: string): ThreadRef {
  return registryPath === undefined ? { threadId } : { threadId, registryPath };
}

/** Spread `registryPath` into an LHC threads-call options object only when it is
 *  set, so an unset registry path falls through to LHC's default rather than
 *  being passed as an explicit `undefined` (rejected under
 *  exactOptionalPropertyTypes). */
export function registryArg(registryPath?: string): { registryPath?: string } {
  return registryPath === undefined ? {} : { registryPath };
}

/** Resolve the recording thread from the launch input:
 *  - `--lhc-thread <id>`: a named thread by full or partial id; unresolvable or
 *    ambiguous fails loud (the registry returns `thread_not_found` /
 *    `ambiguous_thread_id`) and never silently creates a thread.
 *  - `--lhc-continue`: the most recently created thread.
 *  - no flag: a new thread, registered with its cwd.
 *  Reload reuses this via `{ thread: <resolved id> }`, reconstructing from the
 *  durable id rather than a retained object. */
export async function resolveThread(launch: LaunchFlags, deps: ResolveDeps): Promise<OpResult<ThreadRef>> {
  if (launch.thread !== undefined) {
    const resolved = await threads.resolve({
      threadId: launch.thread,
      ...registryArg(deps.registryPath),
    });
    if (!resolved.ok) return resolved;
    return { ok: true, value: threadRefById(resolved.value.threadId, deps.registryPath) };
  }

  if (launch.continue === true) {
    const listed = await threads.listThreads({ ...registryArg(deps.registryPath) });
    if (!listed.ok) return listed;
    // The registry lists in creation order with an insertion-order tie-break,
    // so the last row is the most recently created thread.
    const mostRecent = listed.value.at(-1);
    if (mostRecent === undefined) {
      return {
        ok: false,
        error: {
          errorClass: "caller_error",
          code: "thread_not_found",
          reason: "--lhc-continue: no threads exist to continue",
        },
      };
    }
    return { ok: true, value: threadRefById(mostRecent.threadId, deps.registryPath) };
  }

  const created = await threads.newThread({
    filePath: deps.newThreadFilePath(),
    cwd: deps.cwd,
    title: deps.newThreadTitle ?? defaultThreadTitle(deps.cwd),
    ...registryArg(deps.registryPath),
  });
  if (!created.ok) return created;
  return { ok: true, value: threadRefById(created.value.threadId, deps.registryPath) };
}

/** Reload reconstruction: on reload, re-resolve the exact prior threadId that
 *  PI durably stored in the current thread entries. This never
 *  creates, never re-prompts, and never falls back to cwd-most-recent. */
export async function resolveReloadThread(
  threadId: string | null,
  deps: ResolveDeps,
): Promise<OpResult<ThreadRef | null>> {
  if (threadId === null) return { ok: true, value: null };
  return resolveThread({ thread: threadId }, deps);
}
