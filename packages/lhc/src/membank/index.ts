import type { ErrorResult, OpResult } from "../shared-tech/errors.js";
import { info, type ThreadRef } from "../threads/index.js";
import type { MembaseConnection } from "./internal/client.js";

export interface MembaseConfig {
  socketPath: string;
}

export type MembankItemKind = "lesson" | "skill";

export interface MembankAttachment {
  threadId: string;
  bank: string;
  machine: string;
  attachedAt: number;
}

export interface MembankItemSummary {
  id: string;
  kind: MembankItemKind;
  title: string;
  description: string;
  status: "active" | "superseded";
}

export interface MembankItem extends MembankItemSummary {
  body: string;
  citations: readonly { threadId: string; ref: string }[];
  createdAt: number;
  updatedAt: number;
}

export interface MembankSurface {
  attach(ref: ThreadRef, bank: string): Promise<OpResult<MembankAttachment>>;
  detach(ref: ThreadRef): Promise<OpResult<{ threadId: string; bank: string }>>;
  attachment(ref: ThreadRef): Promise<OpResult<MembankAttachment>>;
  list(ref: ThreadRef, kind?: MembankItemKind): Promise<OpResult<readonly MembankItemSummary[]>>;
  get(ref: ThreadRef, id: string): Promise<OpResult<MembankItem>>;
}

const NOT_CONFIGURED: { ok: false; error: ErrorResult } = {
  ok: false,
  error: {
    errorClass: "caller_error",
    code: "membank_not_configured",
    reason: "this SDK was built without membase; pass membase: { socketPath } to initLhc",
  },
};

function invalidInput(reason: string): { ok: false; error: ErrorResult } {
  return { ok: false, error: { errorClass: "caller_error", code: "invalid_membank_input", reason } };
}

const accept = (): null => null;

export function membankSurface(membase: MembaseConnection | null): MembankSurface {
  const onThread = async <A>(
    ref: ThreadRef,
    refuse: (connection: MembaseConnection) => string | null,
    run: (connection: MembaseConnection, threadId: string) => Promise<OpResult<A>>,
  ): Promise<OpResult<A>> => {
    if (membase === null) return NOT_CONFIGURED;
    const refused = refuse(membase);
    if (refused !== null) return invalidInput(refused);
    const thread = await info(ref);
    if (!thread.ok) return thread;
    return run(membase, thread.value.threadId);
  };

  return {
    attach: (ref, bank) =>
      onThread(
        ref,
        (connection) => connection.refuseBankName(bank),
        (connection, threadId) => connection.call((client) => client.Attach({ threadId, bank })),
      ),
    detach: (ref) =>
      onThread(ref, accept, (connection, threadId) => connection.call((client) => client.Detach({ threadId }))),
    attachment: (ref) =>
      onThread(ref, accept, (connection, threadId) => connection.call((client) => client.GetAttachment({ threadId }))),
    list: (ref, kind) =>
      onThread(
        ref,
        (connection) => (kind === undefined ? null : connection.refuseItemKind(kind)),
        (connection, threadId) =>
          connection.call((client) =>
            client.ListItems(kind === undefined ? { scope: { threadId } } : { scope: { threadId }, kind }),
          ),
      ),
    get: (ref, id) =>
      onThread(
        ref,
        (connection) => connection.refuseItemId(id),
        (connection, threadId) => connection.call((client) => client.GetItem({ scope: { threadId }, id })),
      ),
  };
}
