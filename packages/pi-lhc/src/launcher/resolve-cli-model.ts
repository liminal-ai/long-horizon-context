import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSessionRuntimeDiagnostic, Args, ModelRegistry } from "@earendil-works/pi-coding-agent";

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export interface ResolvedLauncherCliModel {
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  cliThinkingFromModel: boolean;
  diagnostics: AgentSessionRuntimeDiagnostic[];
}

function parseThinkingSuffix(pattern: string): { body: string; thinkingLevel?: ThinkingLevel } {
  const colonIdx = pattern.lastIndexOf(":");
  if (colonIdx === -1) return { body: pattern };
  const suffix = pattern.slice(colonIdx + 1);
  if (!VALID_THINKING_LEVELS.has(suffix as ThinkingLevel)) return { body: pattern };
  return { body: pattern.slice(0, colonIdx), thinkingLevel: suffix as ThinkingLevel };
}

function findExactModelIn(models: Model<Api>[], reference: string): Model<Api> | undefined {
  const lower = reference.toLowerCase();
  return models.find(
    (model) => model.id.toLowerCase() === lower || `${model.provider}/${model.id}`.toLowerCase() === lower,
  );
}

/** Resolve --provider/--model against exported ModelRegistry surfaces. */
export function resolveLauncherCliModel(parsed: Args, modelRegistry: ModelRegistry): ResolvedLauncherCliModel {
  const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
  if (parsed.model === undefined) {
    return { cliThinkingFromModel: false, diagnostics };
  }

  const available = modelRegistry.getAll();
  if (available.length === 0) {
    diagnostics.push({
      type: "error",
      message: "No models available. Check your installation or add models to models.json.",
    });
    return { cliThinkingFromModel: false, diagnostics };
  }

  const providerMap = new Map<string, string>();
  for (const model of available) {
    providerMap.set(model.provider.toLowerCase(), model.provider);
  }

  let provider = parsed.provider ? providerMap.get(parsed.provider.toLowerCase()) : undefined;
  if (parsed.provider && !provider) {
    diagnostics.push({
      type: "error",
      message: `Unknown provider "${parsed.provider}". Use --list-models to see available providers/models.`,
    });
    return { cliThinkingFromModel: false, diagnostics };
  }

  let pattern = parsed.model;
  if (!provider) {
    const slashIdx = parsed.model.indexOf("/");
    if (slashIdx !== -1) {
      const maybeProvider = parsed.model.slice(0, slashIdx);
      const canonical = providerMap.get(maybeProvider.toLowerCase());
      if (canonical) {
        provider = canonical;
        pattern = parsed.model.slice(slashIdx + 1);
      }
    }
  }

  if (!provider) {
    const exact = findExactModelIn(available, parsed.model);
    if (exact) {
      return { model: exact, cliThinkingFromModel: false, diagnostics };
    }
  }

  if (provider && parsed.provider) {
    const prefix = `${provider}/`;
    if (parsed.model.toLowerCase().startsWith(prefix.toLowerCase())) {
      pattern = parsed.model.slice(prefix.length);
    }
  }

  const { body, thinkingLevel } = parseThinkingSuffix(pattern);
  const candidates = provider ? available.filter((model) => model.provider === provider) : available;
  const model =
    findExactModelIn(candidates, provider ? `${provider}/${body}` : body) ??
    candidates.find((candidate) => candidate.id.toLowerCase() === body.toLowerCase()) ??
    findExactModelIn(available, parsed.model);

  if (!model) {
    diagnostics.push({
      type: "error",
      message: `No model matches "${parsed.model}". Use --list-models to see available models.`,
    });
    return { cliThinkingFromModel: false, diagnostics };
  }

  const resolvedThinking = parsed.thinking ?? thinkingLevel;
  const cliThinkingFromModel = parsed.thinking === undefined && thinkingLevel !== undefined;
  return {
    model,
    ...(resolvedThinking === undefined ? {} : { thinkingLevel: resolvedThinking }),
    cliThinkingFromModel,
    diagnostics,
  };
}
