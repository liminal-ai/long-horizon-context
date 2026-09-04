// Authentication against a t3code server, reusing @t3tools/client-runtime's
// remote authorization helpers (the same code path the web/desktop clients use):
//   pairing token -> POST /oauth/token (bearer access token)
//   GET /api/auth/session (verify)
//   POST /api/auth/websocket-ticket -> ws://.../ws?wsTicket=...
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
  resolveRemoteWebSocketConnectionUrl,
} from "@t3tools/client-runtime/authorization";
import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";

const httpLayer = remoteHttpClientLayer(globalThis.fetch.bind(globalThis));

const run = <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(httpLayer)) as Effect.Effect<A, E, never>);

export interface CachedAuth {
  readonly httpBaseUrl: string;
  readonly bearer: string;
  readonly issuedAt: string;
}

/** Newest pairing token the server printed to its log (`pairingUrl: ...#token=XYZ`). */
export function readPairingTokenFromLog(logPath: string): string | null {
  if (!NodeFS.existsSync(logPath)) return null;
  const text = NodeFS.readFileSync(logPath, "utf8");
  const matches = [...text.matchAll(/#token=([A-Za-z0-9_-]+)/g)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1]![1]!;
}

export function loadCachedAuth(path: string, httpBaseUrl: string): CachedAuth | null {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(path, "utf8")) as CachedAuth;
    if (parsed.httpBaseUrl !== httpBaseUrl || typeof parsed.bearer !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCachedAuth(path: string, auth: CachedAuth): void {
  NodeFS.writeFileSync(path, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
}

export async function bearerIsValid(httpBaseUrl: string, bearer: string): Promise<boolean> {
  try {
    const state = await run(fetchRemoteSessionState({ httpBaseUrl, bearerToken: bearer }));
    return state.authenticated === true;
  } catch {
    return false;
  }
}

export async function exchangePairingToken(
  httpBaseUrl: string,
  pairingToken: string,
): Promise<string> {
  const result = await run(
    bootstrapRemoteBearerSession({
      httpBaseUrl,
      credential: pairingToken,
      clientMetadata: { label: "t3code-inject", deviceType: "bot", os: "linux" } as any,
    }),
  );
  return result.access_token;
}

export async function sessionState(httpBaseUrl: string, bearer: string) {
  return run(fetchRemoteSessionState({ httpBaseUrl, bearerToken: bearer }));
}

export async function webSocketUrl(httpBaseUrl: string, bearer: string): Promise<string> {
  const wsBaseUrl = httpBaseUrl.replace(/^http/, "ws");
  return run(
    resolveRemoteWebSocketConnectionUrl({
      wsBaseUrl,
      httpBaseUrl,
      bearerToken: bearer,
      clientMetadata: { surface: "cli", label: "t3code-inject", deviceType: "bot", os: "linux" } as any,
    }),
  );
}

/**
 * Mint a fresh one-time pairing token with the server's own CLI
 * (`t3 auth pairing create`). It writes to the same auth store the running
 * server reads, so the token is immediately exchangeable. Used when the
 * startup token in the log has expired (5 minute TTL) or was already consumed.
 */
export function mintPairingToken(input: {
  readonly checkout: string;
  readonly homeDir: string;
  readonly label?: string;
}): string {
  const out = NodeChildProcess.execFileSync(
    "node",
    [
      "apps/server/dist/bin.mjs",
      "auth",
      "pairing",
      "create",
      "--base-dir",
      input.homeDir,
      "--ttl",
      "10m",
      "--label",
      input.label ?? "t3code-inject",
      "--json",
      "--log-level",
      "error",
    ],
    { cwd: input.checkout, encoding: "utf8", env: { ...process.env, T3CODE_HOME: input.homeDir } },
  );
  const parsed = JSON.parse(out) as { credential: string };
  if (!parsed.credential) throw new Error(`pairing create returned no credential: ${out.slice(0, 200)}`);
  return parsed.credential;
}
