// WebSocket RPC session built from @t3tools/client-runtime's protocol client
// (RpcClient.make(WsRpcGroup)) with the same socket/serialization stack the
// client-runtime's RpcSessionFactory uses. Nothing about the wire protocol is
// reimplemented here; this only wires layers together and exposes promises.
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";
import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import {
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  type ClientOrchestrationCommand,
  type OrchestrationThreadStreamItem,
  type ServerConfig,
} from "@t3tools/contracts";

export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly disconnected: Promise<string>;
  readonly close: () => Promise<void>;
  readonly dispatch: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
  readonly getConfig: () => Promise<ServerConfig>;
  readonly subscribeThread: (
    threadId: string,
    onItem: (item: OrchestrationThreadStreamItem) => void,
    onEnd: (error: string | null) => void,
  ) => Promise<() => Promise<void>>;
}

export async function connectRpc(socketUrl: string): Promise<RpcSession> {
  const scope = await Effect.runPromise(Scope.make());
  let resolveDisconnected: (reason: string) => void = () => {};
  const disconnected = new Promise<string>((resolve) => {
    resolveDisconnected = resolve;
  });
  let connected = false;
  const hooks = RpcClient.ConnectionHooks.of({
    onConnect: Effect.sync(() => {
      connected = true;
    }),
    onDisconnect: Effect.sync(() => {
      resolveDisconnected(connected ? "socket disconnected" : "socket failed to connect");
    }),
  });
  const socketLayer = Socket.layerWebSocket(socketUrl, { openTimeout: "15 seconds" }).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        socketLayer,
        RpcSerialization.layerJson,
        Layer.succeed(RpcClient.ConnectionHooks, hooks),
      ),
    ),
  );
  const context = await Effect.runPromise(
    Layer.build(protocolLayer).pipe(Scope.provide(scope)) as Effect.Effect<any, never, never>,
  );
  const client = (await Effect.runPromise(
    makeWsRpcProtocolClient.pipe(Effect.provide(context), Scope.provide(scope)) as Effect.Effect<
      WsRpcProtocolClient,
      never,
      never
    >,
  )) as WsRpcProtocolClient;

  const runUnary = <A>(effect: Effect.Effect<A, any, any>): Promise<A> =>
    Effect.runPromise(effect as Effect.Effect<A, any, never>);

  return {
    client,
    disconnected,
    close: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
    dispatch: (command) =>
      runUnary(
        (client[ORCHESTRATION_WS_METHODS.dispatchCommand] as any)(command) as Effect.Effect<
          { sequence: number },
          any,
          any
        >,
      ),
    getConfig: () =>
      runUnary((client[WS_METHODS.serverGetConfig] as any)({}) as Effect.Effect<ServerConfig, any, any>),
    subscribeThread: async (threadId, onItem, onEnd) => {
      const stream = (client[ORCHESTRATION_WS_METHODS.subscribeThread] as any)({
        threadId,
      }) as Stream.Stream<OrchestrationThreadStreamItem, any, any>;
      const fiber = Effect.runFork(
        Stream.runForEach(stream, (item) => Effect.sync(() => onItem(item))).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isSuccess(exit)) onEnd(null);
              else if (!exit.cause.reasons.every((r) => r._tag === "Interrupt"))
                onEnd(String(exit.cause));
              else onEnd(null);
            }),
          ),
        ) as Effect.Effect<void, never, never>,
      );
      return async () => {
        await Effect.runPromise(Fiber.interrupt(fiber));
      };
    },
  };
}
