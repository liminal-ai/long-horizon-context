import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { CompactPolicy } from "./compactPolicy.js";

/** Controls claude-lhc adds to the SDK `Query`. */
export interface LhcControls {
  setCompactPolicy(policy: CompactPolicy): Promise<void>;
}

type Controls = Query & LhcControls;
type Args<M extends keyof Controls> = Controls[M] extends (...args: infer A) => unknown ? A : never;
/** The method's SDK parameter names in order. A name ending in `?` may be left out of `params`. */
type ParamNames<A extends readonly unknown[]> = { [K in keyof A]-?: undefined extends A[K] ? `${string}?` : string };

/**
 * replay: forwarded to the live generation and sent again to every later one, because a compact
 * swap starts a new Claude session. A call replaces the earlier call in its slot, or merges into it.
 * forward: sent to the live generation as it is.
 * refuse: changes the Claude session outside the LHC record.
 * lhc: handled by claude-lhc, with no `Query` method behind it.
 */
type Row<M extends keyof Controls> =
  | {
      kind: "replay";
      params: ParamNames<Args<M>>;
      slot?: (args: Args<M>) => string;
      merge?: (earlier: Args<M>, later: Args<M>) => Args<M>;
    }
  | { kind: "forward" | "lhc"; params: ParamNames<Args<M>> }
  | { kind: "refuse" };

const byServer = ([serverName]: readonly [string, ...unknown[]]): string => serverName;

export const CONTROLS = {
  setModel: { kind: "replay", params: ["model?"] },
  setPermissionMode: { kind: "replay", params: ["mode"] },
  setMaxThinkingTokens: { kind: "replay", params: ["maxThinkingTokens", "thinkingDisplay?"] },
  setMcpServers: { kind: "replay", params: ["servers"] },
  applyFlagSettings: {
    kind: "replay",
    params: ["settings"],
    merge: ([earlier], [later]) => [{ ...earlier, ...later }],
  },
  updateSettings: {
    kind: "replay",
    params: ["source", "settings"],
    slot: ([source]) => source,
    merge: ([, earlier], [source, later]) => [source, { ...earlier, ...later }],
  },
  toggleMcpServer: { kind: "replay", params: ["serverName", "enabled"], slot: byServer },
  setMcpPermissionModeOverride: { kind: "replay", params: ["serverName", "mode"], slot: byServer },

  interrupt: { kind: "forward", params: [] },
  stopTask: { kind: "forward", params: ["taskId"] },
  backgroundTasks: { kind: "forward", params: ["toolUseId?"] },
  initializationResult: { kind: "forward", params: [] },
  supportedCommands: { kind: "forward", params: [] },
  supportedModels: { kind: "forward", params: [] },
  supportedAgents: { kind: "forward", params: [] },
  mcpServerStatus: { kind: "forward", params: [] },
  getContextUsage: { kind: "forward", params: ["opts?"] },
  accountInfo: { kind: "forward", params: [] },
  readFile: { kind: "forward", params: ["path", "options?"] },
  reconnectMcpServer: { kind: "forward", params: ["serverName"] },
  reloadPlugins: { kind: "forward", params: ["options?"] },
  reloadSkills: { kind: "forward", params: [] },
  reloadOutputStyles: { kind: "forward", params: [] },

  rewindFiles: { kind: "refuse" },
  reinitialize: { kind: "refuse" },
  seedReadState: { kind: "refuse" },

  setCompactPolicy: { kind: "lhc", params: ["policy"] },
} as const satisfies { [M in keyof Controls]?: Row<M> };

export type ControlMethod = keyof typeof CONTROLS;
type MethodOf<K> = { [M in ControlMethod]: (typeof CONTROLS)[M]["kind"] extends K ? M : never }[ControlMethod];
export type QueryControlMethod = MethodOf<"replay" | "forward">;

/** A host control with its params mapped onto the method's positional arguments. */
export type ControlCall =
  | { kind: "replay" | "forward"; method: QueryControlMethod; args: readonly unknown[] }
  | { kind: "lhc"; method: MethodOf<"lhc">; args: readonly unknown[] };

interface ReplayRow {
  slot?: (args: readonly unknown[]) => string;
  merge?: (earlier: readonly unknown[], later: readonly unknown[]) => readonly unknown[];
}

export function parseControl(method: string, params: unknown): ControlCall {
  if (!Object.hasOwn(CONTROLS, method)) throw new Error(`unknown control ${method}`);
  const row = CONTROLS[method as ControlMethod];
  if (row.kind === "refuse")
    throw new Error(`${method} is refused: it changes the Claude session outside the LHC record`);
  const record = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
  const args = row.params.map((name: string) => {
    const key = name.endsWith("?") ? name.slice(0, -1) : name;
    if (key === name && record[key] === undefined) throw new Error(`${method} needs params.${key}`);
    return record[key];
  });
  return { kind: row.kind, method, args } as ControlCall;
}

/** The replay calls a new generation needs, in the order the host last made them. */
export class ReplayLedger {
  readonly #calls = new Map<string, ControlCall>();

  record(call: ControlCall): void {
    const row = CONTROLS[call.method] as ReplayRow;
    const slot = `${call.method}:${row.slot?.(call.args) ?? ""}`;
    const earlier = this.#calls.get(slot);
    this.#calls.delete(slot);
    this.#calls.set(
      slot,
      earlier !== undefined && row.merge !== undefined ? { ...call, args: row.merge(earlier.args, call.args) } : call,
    );
  }

  calls(): readonly ControlCall[] {
    return [...this.#calls.values()];
  }
}
