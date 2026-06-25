import type { Args } from "@earendil-works/pi-coding-agent";

export type LauncherAppMode = "interactive" | "print" | "json" | "rpc";

/** Mirror PI main's app-mode resolution for the launcher path. */
export function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): LauncherAppMode {
  if (parsed.mode === "rpc") {
    return "rpc";
  }
  if (parsed.mode === "json") {
    return "json";
  }
  if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
    return "print";
  }
  return "interactive";
}

export function toPrintOutputMode(appMode: LauncherAppMode): "text" | "json" {
  return appMode === "json" ? "json" : "text";
}

export function isPrintLikeMode(
  parsed: Args,
  stdinIsTTY = process.stdin.isTTY,
  stdoutIsTTY = process.stdout.isTTY,
): boolean {
  const appMode = resolveAppMode(parsed, stdinIsTTY, stdoutIsTTY);
  return appMode === "print" || appMode === "json";
}

/** Read piped stdin when not attached to a TTY (same contract as PI main). */
export async function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return undefined;
  }
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data.length > 0 ? data : undefined);
    });
    process.stdin.resume();
  });
}

/** Combine piped stdin and positional prompts for print/json mode. */
export function preparePrintPrompt(
  parsed: Args,
  stdinContent?: string,
): { initialMessage?: string; messages: string[] } {
  const messages = [...parsed.messages];
  const parts: string[] = [];
  if (stdinContent !== undefined) {
    parts.push(stdinContent);
  }
  if (messages.length > 0) {
    parts.push(messages.shift() as string);
  }
  const initialMessage = parts.length > 0 ? parts.join("") : undefined;
  return initialMessage === undefined ? { messages } : { initialMessage, messages };
}
