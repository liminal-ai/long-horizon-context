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
  ThreadId,
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
  if (error._tag === "RpcClientError") return `membase RPC on ${socketPath} failed: ${innermostMessage(error)}`;
  if (error._tag === "TimeoutError") {
    return `membase did not answer on ${socketPath} within ${MEMBASE_CALL_TIMEOUT_MS} ms`;
  }
  const fields = Object.entries(error)
    .filter(([key]) => key !== "_tag")
    .map(([key, value]) => `${key}=${String(value)}`);
  return [error._tag, ...fields].join(" ");
}

function isMembaseError(error: unknown): error is MembaseError {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
  return typeof error._tag === "string" && Object.hasOwn(ERROR_CODES, error._tag);
}

function toErrorResult(failure: unknown, socketPath: string): { ok: false; error: ErrorResult } {
  if (isMembaseError(failure)) {
    return { ok: false, error: { ...ERROR_CODES[failure._tag], reason: describe(failure, socketPath) } };
  }
  const detail = failure instanceof Error ? failure.message : JSON.stringify(failure);
  return {
    ok: false,
    error: {
      errorClass: "system_error",
      code: "membase_unavailable",
      reason: `membase on ${socketPath} answered outside its contract: ${detail}`,
    },
  };
}

export interface MembaseConnection {
  call<A>(use: (client: MembaseClient) => Effect.Effect<A, MembaseError>): Promise<OpResult<A>>;
  refuseThreadId(value: unknown): string | null;
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
      RpcClient.make(MembaseRpcs)
        .pipe(
          Effect.flatMap(use),
          Effect.timeout(MEMBASE_CALL_TIMEOUT_MS),
          Effect.scoped,
          Effect.provide(protocol),
          Effect.runPromiseExit,
        )
        .then((exit) =>
          Exit.isSuccess(exit)
            ? { ok: true as const, value: exit.value }
            : toErrorResult(Cause.squash(exit.cause), socketPath),
        ),
    refuseThreadId: (value) => refusal(Schema.decodeUnknownExit(ThreadId)(value)),
    refuseBankName: (value) => refusal(Schema.decodeUnknownExit(BankName)(value)),
    refuseItemId: (value) => refusal(Schema.decodeUnknownExit(ItemId)(value)),
    refuseItemKind: (value) => refusal(Schema.decodeUnknownExit(ItemKind)(value)),
  };
}

export function handshake(connection: MembaseConnection): Promise<OpResult<{ apiVersion: number; convexUrl: string }>> {
  return connection.call((client) => client.Health({ apiVersion: MEMBASE_API_VERSION }));
}
