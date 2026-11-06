import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import {
  type AlreadyAttached,
  BankName,
  type BankNotFound,
  ItemId,
  ItemKind,
  type ItemNotFound,
  MEMBASE_API_VERSION,
  MembaseProtocol,
  MembaseRpcs,
  type NotAttached,
  type NotEnrolled,
  type SecretFileUnreadable,
  type StoreUnavailable,
  type Unauthorized,
  type VersionMismatch,
} from "@membase/contract";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { RpcClient, type RpcClientError } from "effect/rpc";
import type { ErrorClass, ErrorCode, ErrorResult, OpResult } from "../../shared-tech/errors.js";

export const MEMBASE_CALL_TIMEOUT_MS = 5_000;

export type MembaseClient = RpcClient.FromGroup<typeof MembaseRpcs, RpcClientError.RpcClientError>;

type MembaseError =
  | AlreadyAttached
  | BankNotFound
  | ItemNotFound
  | NotAttached
  | NotEnrolled
  | SecretFileUnreadable
  | StoreUnavailable
  | Unauthorized
  | VersionMismatch
  | RpcClientError.RpcClientError
  | Cause.TimeoutError;

const ERROR_CODES: Record<MembaseError["_tag"], { errorClass: ErrorClass; code: ErrorCode }> = {
  AlreadyAttached: { errorClass: "caller_error", code: "already_attached" },
  BankNotFound: { errorClass: "caller_error", code: "bank_not_found" },
  ItemNotFound: { errorClass: "caller_error", code: "item_not_found" },
  NotAttached: { errorClass: "caller_error", code: "not_attached" },
  NotEnrolled: { errorClass: "system_error", code: "membase_unavailable" },
  SecretFileUnreadable: { errorClass: "system_error", code: "membase_unavailable" },
  StoreUnavailable: { errorClass: "system_error", code: "membase_unavailable" },
  Unauthorized: { errorClass: "system_error", code: "membase_unavailable" },
  VersionMismatch: { errorClass: "system_error", code: "membase_version_mismatch" },
  RpcClientError: { errorClass: "system_error", code: "membase_unreachable" },
  TimeoutError: { errorClass: "system_error", code: "membase_unreachable" },
};

function innermostMessage(error: unknown): string {
  let current: unknown = error;
  let message = "";
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    const node = current as { message?: unknown; reason?: unknown; cause?: unknown };
    if (typeof node.message === "string" && node.message.trim() !== "") message = node.message;
    current = typeof node.reason === "object" ? node.reason : node.cause;
  }
  return message;
}

function describe(error: MembaseError, socketPath: string): string {
  if (error._tag === "RpcClientError") return `membase did not answer on ${socketPath}: ${innermostMessage(error)}`;
  if (error._tag === "TimeoutError") {
    return `membase did not answer on ${socketPath} within ${MEMBASE_CALL_TIMEOUT_MS} ms`;
  }
  const fields = Object.entries(error)
    .filter(([key]) => key !== "_tag")
    .map(([key, value]) => `${key}=${String(value)}`);
  return [error._tag, ...fields].join(" ");
}

function toErrorResult(error: MembaseError, socketPath: string): { ok: false; error: ErrorResult } {
  return { ok: false, error: { ...ERROR_CODES[error._tag], reason: describe(error, socketPath) } };
}

export interface MembaseConnection {
  call<A>(use: (client: MembaseClient) => Effect.Effect<A, MembaseError>): Promise<OpResult<A>>;
  refuseBankName(value: unknown): string | null;
  refuseItemId(value: unknown): string | null;
  refuseItemKind(value: unknown): string | null;
}

function refusal(decoded: Exit.Exit<unknown, Schema.SchemaError>): string | null {
  if (Exit.isSuccess(decoded)) return null;
  const error = Cause.squash(decoded.cause);
  return error instanceof Error ? error.message : String(error);
}

export function connectMembase(socketPath: string): MembaseConnection {
  const protocol = MembaseProtocol.pipe(Layer.provide(NodeHttpClient.layerUndiciOptions({ connect: { socketPath } })));
  return {
    call: (use) =>
      RpcClient.make(MembaseRpcs).pipe(
        Effect.flatMap(use),
        Effect.timeout(MEMBASE_CALL_TIMEOUT_MS),
        Effect.scoped,
        Effect.provide(protocol),
        Effect.match({
          onFailure: (error) => toErrorResult(error, socketPath),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
        Effect.runPromise,
      ),
    refuseBankName: (value) => refusal(Schema.decodeUnknownExit(BankName)(value)),
    refuseItemId: (value) => refusal(Schema.decodeUnknownExit(ItemId)(value)),
    refuseItemKind: (value) => refusal(Schema.decodeUnknownExit(ItemKind)(value)),
  };
}

export function handshake(connection: MembaseConnection): Promise<OpResult<{ apiVersion: number; convexUrl: string }>> {
  return connection.call((client) => client.Health({ apiVersion: MEMBASE_API_VERSION }));
}
