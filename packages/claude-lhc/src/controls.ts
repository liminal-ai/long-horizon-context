import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { CompactPolicy } from "./compactPolicy.js";

export interface LhcControls {
  setCompactPolicy(policy: CompactPolicy): Promise<void>;
}

type Controls = Query & LhcControls;
type Args<M extends keyof Controls> = Controls[M] extends (...args: infer A) => unknown ? A : never;
type Param<T> = undefined extends T ? { optional: string } : string;
type Params<A extends readonly unknown[]> = { [K in keyof A]-?: Param<A[K]> };

type Row<M extends keyof Controls> =
  | {
      kind: "forward-and-replay";
      params: Params<Args<M>>;
      slot?: (args: Args<M>) => string;
      merge?: (earlier: Args<M>, later: Args<M>) => Args<M>;
    }
  | { kind: "forward" | "sidecar"; params: Params<Args<M>> }
  | { kind: "refuse" };

const byServer = ([serverName]: readonly [string, ...unknown[]]): string => serverName;

export const CONTROLS = {
  setModel: { kind: "forward-and-replay", params: [{ optional: "model" }] },
  setPermissionMode: { kind: "forward-and-replay", params: ["mode"] },
  setMaxThinkingTokens: { kind: "forward-and-replay", params: ["maxThinkingTokens", { optional: "thinkingDisplay" }] },
  setMcpServers: { kind: "forward-and-replay", params: ["servers"] },
  applyFlagSettings: {
    kind: "forward-and-replay",
    params: ["settings"],
    merge: ([earlier], [later]) => [{ ...earlier, ...later }],
  },
  updateSettings: {
    kind: "forward-and-replay",
    params: ["source", "settings"],
    slot: ([source]) => source,
    merge: ([, earlier], [source, later]) => [source, { ...earlier, ...later }],
  },
  toggleMcpServer: { kind: "forward-and-replay", params: ["serverName", "enabled"], slot: byServer },
  setMcpPermissionModeOverride: { kind: "forward-and-replay", params: ["serverName", "mode"], slot: byServer },

  interrupt: { kind: "forward", params: [] },
  stopTask: { kind: "forward", params: ["taskId"] },
  backgroundTasks: { kind: "forward", params: [{ optional: "toolUseId" }] },
  initializationResult: { kind: "forward", params: [] },
  supportedCommands: { kind: "forward", params: [] },
  supportedModels: { kind: "forward", params: [] },
  supportedAgents: { kind: "forward", params: [] },
  mcpServerStatus: { kind: "forward", params: [] },
  getContextUsage: { kind: "forward", params: [{ optional: "opts" }] },
  accountInfo: { kind: "forward", params: [] },
  readFile: { kind: "forward", params: ["path", { optional: "options" }] },
  reconnectMcpServer: { kind: "forward", params: ["serverName"] },
  reloadPlugins: { kind: "forward", params: [{ optional: "options" }] },
  reloadSkills: { kind: "forward", params: [] },
  reloadOutputStyles: { kind: "forward", params: [] },

  rewindFiles: { kind: "refuse" },
  reinitialize: { kind: "refuse" },
  seedReadState: { kind: "refuse" },

  setCompactPolicy: { kind: "sidecar", params: ["policy"] },
} as const satisfies { [M in keyof Controls]?: Row<M> };

export type ControlMethod = keyof typeof CONTROLS;
type MethodOf<K> = { [M in ControlMethod]: (typeof CONTROLS)[M]["kind"] extends K ? M : never }[ControlMethod];
export type QueryControlMethod = MethodOf<"forward-and-replay" | "forward">;

export type ControlCall =
  | { kind: "forward-and-replay" | "forward"; method: QueryControlMethod; args: readonly unknown[] }
  | { kind: "sidecar"; method: MethodOf<"sidecar">; args: readonly unknown[] };

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
  const args = row.params.map((param: string | { optional: string }) => {
    if (typeof param !== "string") return record[param.optional];
    if (record[param] === undefined) throw new Error(`${method} needs params.${param}`);
    return record[param];
  });
  return { kind: row.kind, method, args } as ControlCall;
}

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

  inLastCallOrder(): readonly ControlCall[] {
    return [...this.#calls.values()];
  }
}
