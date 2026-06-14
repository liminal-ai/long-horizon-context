// Extension entry. PI loads this module and calls `activate(pi)`; it registers
// the Epic 1 observe-only hook rail and routes each hook to a fail-closed
// handler. It owns no state beyond the plain-data `SessionState` (and, later, an
// `LhcInstance`) held in the connector closure — never a PI `ctx`/session
// object (tech design Flow 1, plain-data rule).
import type {
  ExtensionAPI,
  PiHookHandler,
  PiHookName,
} from "./pi/types.js";
import type { CaptureFailureDiagnostic, SessionState } from "./lifecycle/state.js";

export { disposeInstance, initInstance, initLhc } from "./lifecycle/instance.js";
export type { LhcInstance } from "./shared/instance.js";

/** The Epic 1 observe-only hook rail: every PI hook the connector consumes.
 *  Deliberately NOT `context` — context serving is Epic 2 and this epic
 *  registers no handler for it (story Scope Out). */
export const EPIC_1_HOOKS = [
  "session_start",
  "message_end",
  "turn_end",
  "agent_end",
  "model_select",
  "thinking_level_select",
  "session_before_fork",
  "session_before_switch",
  "session_shutdown",
] as const satisfies readonly PiHookName[];

export type Epic1Hook = (typeof EPIC_1_HOOKS)[number];

/** Everything the connector retains across hooks — all plain data, by
 *  construction structuredClone-able. There is no field that could hold a PI
 *  object. */
export interface ConnectorSnapshot {
  state: SessionState | null;
  lastDiagnostic: CaptureFailureDiagnostic | null;
}

export interface Connector {
  /** Register the observe-only hook rail on the PI extension API. */
  register(pi: ExtensionAPI): void;
  /** The plain-data state retained across hooks. `null` until a session
   *  resolves a thread (Story 1); never holds a PI ctx. */
  getState(): SessionState | null;
  /** Plain-data snapshot of all retained state (inspection/test seam). */
  snapshot(): ConnectorSnapshot;
  /** The hook handlers, keyed by event — exposed so tests can drive them with
   *  synthetic ctx/events without a live PI. Each accepts any Epic 1 event
   *  (the foundation handlers are uniform no-ops). */
  readonly handlers: Readonly<Record<Epic1Hook, PiHookHandler<Epic1Hook>>>;
}

/** Build a connector instance. Its mutable state lives in this closure; the
 *  registered handlers capture it, so the instance stays live for the session
 *  even when `activate` discards the returned object. */
export function createConnector(): Connector {
  // The connector's ENTIRE retained state. Both are plain data and are the only
  // things that survive between hooks. `state` stays null in Epic 1 Story 0
  // (thread resolution is fail-closed until Story 1); Story 1 populates it via
  // createSessionState once a thread resolves.
  let state: SessionState | null = null;
  let lastDiagnostic: CaptureFailureDiagnostic | null = null;

  // Contain every handler: an observe-only hook must never throw back into PI
  // (a thrown hook breaks the user's session). A caught error becomes a
  // plain-data diagnostic; it is never rethrown.
  const guard = (
    name: Epic1Hook,
    body: PiHookHandler<Epic1Hook>,
  ): PiHookHandler<Epic1Hook> => {
    return async (ctx, event): Promise<void> => {
      try {
        await body(ctx, event);
      } catch (err) {
        lastDiagnostic = {
          code: "hook_handler_error",
          message: `${name}: ${err instanceof Error ? err.message : String(err)}`,
          recordedGap: false,
        };
      }
    };
  };

  // Observe-only foundation: every hook routes to a no-op that receives a FRESH
  // ctx and retains none of it.
  const noop: PiHookHandler<Epic1Hook> = () => {
    // Intentionally empty — later stories replace this with real routing.
  };

  // Story 0 routes each hook to a fail-closed no-op: the rail is real and routes
  // to a handler, but no capture / resolution / derivation happens or is faked
  // yet. The accumulator is filled for every hook in the loop below.
  const handlers = {} as Record<Epic1Hook, PiHookHandler<Epic1Hook>>;
  for (const name of EPIC_1_HOOKS) handlers[name] = guard(name, noop);

  return {
    handlers,
    register(pi: ExtensionAPI): void {
      for (const name of EPIC_1_HOOKS) pi.registerHook(name, handlers[name]);
    },
    getState(): SessionState | null {
      return state;
    },
    snapshot(): ConnectorSnapshot {
      return { state, lastDiagnostic };
    },
  };
}

/** PI entry point: PI calls this with the ExtensionAPI when the extension
 *  loads (and again on `/reload`). Registers the observe-only hook rail. */
export function activate(pi: ExtensionAPI): void {
  createConnector().register(pi);
}

export default activate;
