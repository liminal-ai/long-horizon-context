import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
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
      remainder?: (earlier: Args<M>, later: Args<M>) => Args<M> | null;
    }
  | { kind: "forward" | "sidecar"; params: Params<Args<M>> }
  | { kind: "refuse" | "transport" };

type QueryMethod = Exclude<keyof Query, keyof AsyncGenerator<SDKMessage, void>>;
type Table = { [M in QueryMethod]: Row<M> } & { [M in keyof LhcControls]: Row<M> };

const byServer = ([serverName]: readonly [string, ...unknown[]]): string => serverName;

function keysNotIn<T extends object>(earlier: T, later: object): T | null {
  const rest = Object.fromEntries(Object.entries(earlier).filter(([key]) => !Object.hasOwn(later, key)));
  return Object.keys(rest).length === 0 ? null : (rest as T);
}

export const CONTROLS = {
  setModel: { kind: "forward-and-replay", params: [{ optional: "model" }] },
  setPermissionMode: { kind: "forward-and-replay", params: ["mode"] },
  setMaxThinkingTokens: { kind: "forward-and-replay", params: ["maxThinkingTokens", { optional: "thinkingDisplay" }] },
  setMcpServers: { kind: "forward-and-replay", params: ["servers"] },
  applyFlagSettings: {
    kind: "forward-and-replay",
    params: ["settings"],
    remainder: ([earlier], [later]) => {
      const rest = keysNotIn(earlier, later);
      return rest === null ? null : [rest];
    },
  },
  updateSettings: {
    kind: "forward-and-replay",
    params: ["source", "settings"],
    slot: ([source]) => source,
    remainder: ([source, earlier], [, later]) => {
      const rest = keysNotIn(earlier, later);
      return rest === null ? null : [source, rest];
    },
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
  readMcpResource: { kind: "forward", params: ["serverName", "uri"] },
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: { kind: "forward", params: [{ optional: "opts" }] },

  rewindFiles: { kind: "refuse" },
  reinitialize: { kind: "refuse" },
  seedReadState: { kind: "refuse" },

  streamInput: { kind: "transport" },
  close: { kind: "transport" },

  setCompactPolicy: { kind: "sidecar", params: ["policy"] },
} as const satisfies Table;

export type ControlMethod = keyof typeof CONTROLS;
type MethodOf<K> = { [M in ControlMethod]: (typeof CONTROLS)[M]["kind"] extends K ? M : never }[ControlMethod];
export type QueryControlMethod = MethodOf<"forward-and-replay" | "forward">;

export type ControlCall =
  | { kind: "forward-and-replay" | "forward"; method: QueryControlMethod; args: readonly unknown[] }
  | { kind: "sidecar"; method: MethodOf<"sidecar">; args: readonly unknown[] };

interface ReplayRow {
  slot?: (args: readonly unknown[]) => string;
  remainder?: (earlier: readonly unknown[], later: readonly unknown[]) => readonly unknown[] | null;
}

const slotOf = (call: ControlCall): string =>
  `${call.method}:${(CONTROLS[call.method] as ReplayRow).slot?.(call.args) ?? ""}`;

export function parseControl(method: string, params: unknown): ControlCall {
  if (!Object.hasOwn(CONTROLS, method)) throw new Error(`unknown control ${method}`);
  const row = CONTROLS[method as ControlMethod];
  if (row.kind === "refuse")
    throw new Error(`${method} is refused: it changes the Claude session outside the LHC record`);
  if (row.kind === "transport")
    throw new Error(`${method} is not a control: the client handles it on the sidecar's stdio`);
  const record = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
  const args = row.params.map((param: string | { optional: string }) => {
    if (typeof param !== "string") return record[param.optional];
    if (record[param] === undefined) throw new Error(`${method} needs params.${param}`);
    return record[param];
  });
  return { kind: row.kind, method, args } as ControlCall;
}

export class ReplayLedger {
  #entries: Array<{ seq: number; call: ControlCall }> = [];
  #seq = 0;

  get seq(): number {
    return this.#seq;
  }

  record(call: ControlCall): void {
    const { remainder } = CONTROLS[call.method] as ReplayRow;
    const slot = slotOf(call);
    this.#entries = this.#entries.flatMap((entry) => {
      if (slotOf(entry.call) !== slot) return [entry];
      const rest = remainder?.(entry.call.args, call.args) ?? null;
      return rest === null ? [] : [{ ...entry, call: { ...entry.call, args: rest } }];
    });
    this.#entries.push({ seq: ++this.#seq, call });
  }

  recordedAfter(seq: number): readonly ControlCall[] {
    return this.#entries.filter((entry) => entry.seq > seq).map((entry) => entry.call);
  }
}
