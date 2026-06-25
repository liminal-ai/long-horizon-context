import type {
  AgentSessionRuntimeDiagnostic,
  Args,
  CreateAgentSessionFromServicesOptions,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedLauncherCliModel } from "./resolve-cli-model.js";

export interface LauncherSessionOptionsResult {
  sessionOptions: Pick<
    CreateAgentSessionFromServicesOptions,
    "model" | "thinkingLevel" | "tools" | "excludeTools" | "noTools"
  >;
  cliThinkingFromModel: boolean;
  diagnostics: AgentSessionRuntimeDiagnostic[];
}

/** Map parsed PI argv into createAgentSessionFromServices inputs. */
export function buildLauncherSessionOptions(
  parsed: Args,
  resolved: ResolvedLauncherCliModel,
): LauncherSessionOptionsResult {
  const diagnostics = [...resolved.diagnostics];
  const sessionOptions: LauncherSessionOptionsResult["sessionOptions"] = {};

  if (resolved.model) {
    sessionOptions.model = resolved.model;
  }
  if (resolved.thinkingLevel) {
    sessionOptions.thinkingLevel = resolved.thinkingLevel;
  }
  if (parsed.thinking) {
    sessionOptions.thinkingLevel = parsed.thinking;
  }

  if (parsed.noTools) {
    sessionOptions.noTools = "all";
  } else if (parsed.noBuiltinTools) {
    sessionOptions.noTools = "builtin";
  }
  if (parsed.tools) {
    sessionOptions.tools = [...parsed.tools];
  }
  if (parsed.excludeTools) {
    sessionOptions.excludeTools = [...parsed.excludeTools];
  }

  return {
    sessionOptions,
    cliThinkingFromModel: resolved.cliThinkingFromModel,
    diagnostics,
  };
}
