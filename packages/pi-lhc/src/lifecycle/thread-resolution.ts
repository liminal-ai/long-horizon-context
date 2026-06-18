import { basename } from "node:path";
import { type OpResult, type ThreadRef, threads } from "lhc";

// AC-1.2, AC-1.5, AC-1.6. Launch flags name the thread; the registry resolves
// it (tech design Flow 1). PI's own session file still exists in this
// observe-only epic — it is just not where thread identity lives.

/** None set → new thread. (`--resume`/`-r` is owned by the picker, routed
 *  before this resolver — see `picker.ts`.) */
export interface LaunchFlags {
  resume?: boolean; // --resume / -r : cwd-scoped picker (handled by picker.ts)
  continue?: boolean; // --continue / -c : most recent
  session?: string; // --session <id> : full or partial id
}

/** What the resolver needs from the host beyond the launch flags: the cwd a new
 *  thread is registered under, the registry to resolve through, and where a new
 *  thread's file is created. Injected so the resolver is exercised against a
 *  real temp registry in tests and the default `~/.lhc` registry in production —
 *  `registryPath` is a per-operation argument, never an `initLhc` config field
 *  (tech design Technical Notes). */
export interface ResolveDeps {
  cwd: string;
  registryPath?: string;
  newThreadFilePath: () => string;
  /** Title for a newly created thread (A-8 title metadata). Defaults to
   *  `defaultThreadTitle(cwd)` so every connector-created thread is titled
   *  (AC-1.1 / TC-1.1); a host may override it (e.g. once Story 2 derives a
   *  title from the first prompt — the open TDQ Q4). */
  newThreadTitle?: string;
}

/** The creation-time title for a new thread when the host supplies none. At
 *  session_start there is no first prompt yet, so the title is the cwd's leaf
 *  directory name — a real, non-empty project label the `--resume` picker shows
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

/** Resolve the recording thread from the launch input (AC-1.6):
 *  - `--session <id>`: a named thread by full or partial id; unresolvable or
 *    ambiguous fails loud (the registry returns `thread_not_found` /
 *    `ambiguous_thread_id`) and never silently creates a thread.
 *  - `--continue`: the most recently created thread.
 *  - no flag: a new thread, registered with its cwd (AC-1.1).
 *  Reload reuses this via `{ session: <resolved id> }`, reconstructing from the
 *  durable id rather than a retained object (AC-1.5). */
export async function resolveThread(launch: LaunchFlags, deps: ResolveDeps): Promise<OpResult<ThreadRef>> {
  if (launch.session !== undefined) {
    const resolved = await threads.resolve({
      threadId: launch.session,
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
          reason: "--continue: no threads exist to continue",
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

/** Reload reconstruction (AC-1.5): on reload, re-resolve the exact prior
 *  threadId that PI durably stored in the current session entries. This never
 *  creates, never re-prompts, and never falls back to cwd-most-recent. */
export async function resolveReloadThread(
  threadId: string | null,
  deps: ResolveDeps,
): Promise<OpResult<ThreadRef | null>> {
  if (threadId === null) return { ok: true, value: null };
  return resolveThread({ session: threadId }, deps);
}

/** Map a launch argv to `LaunchFlags`. The connector runs in-process inside PI,
 *  so PI's launch arguments are visible on `process.argv`; this is the
 *  production source of the launch mode. Supports `--session <id>`,
 *  `--session=<id>`, `--continue`/`-c`, and `--resume`/`-r`. (The exact PI flag
 *  spelling for the named-session mode is an integration detail to confirm
 *  against PI; see the story payload's open questions.) */
export function parseLaunchFlags(argv: readonly string[]): LaunchFlags {
  const flags: LaunchFlags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--resume" || arg === "-r") {
      flags.resume = true;
    } else if (arg === "--continue" || arg === "-c") {
      flags.continue = true;
    } else if (arg === "--session") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.session = next;
        i += 1;
      }
    } else if (arg.startsWith("--session=")) {
      flags.session = arg.slice("--session=".length);
    }
  }
  return flags;
}
