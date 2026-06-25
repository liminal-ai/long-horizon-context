import type { Args } from "@earendil-works/pi-coding-agent";
import { isPrintLikeMode } from "./app-mode.js";

/** Return a user-facing error when argv requests launcher-unsupported PI behavior. */
export function unsupportedLauncherFlagError(parsed: Args): string | null {
  if (parsed.mode === "rpc") {
    return "--mode rpc is not supported on the pi-lhc launcher";
  }
  if (parsed.models !== undefined) {
    return "--models is not supported on the pi-lhc launcher";
  }
  if (parsed.export !== undefined) {
    return "--export is not supported on the pi-lhc launcher";
  }
  if (parsed.noSession) {
    return "--no-session is not supported on the pi-lhc launcher";
  }
  if (!isPrintLikeMode(parsed)) {
    if (parsed.messages.length > 0) {
      return "positional prompt messages are not supported on the pi-lhc launcher (use --print or --mode json)";
    }
  }
  if (parsed.fileArgs.length > 0) {
    return "@file prompt arguments are not supported on the pi-lhc launcher";
  }
  return null;
}
