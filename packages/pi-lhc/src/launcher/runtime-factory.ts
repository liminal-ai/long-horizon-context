import type { Args } from "@earendil-works/pi-coding-agent";
import {
  type AgentSessionRuntimeDiagnostic,
  type AuthStorage,
  type CreateAgentSessionFromServicesOptions,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionFactory,
  hasTrustRequiringProjectResources,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { resolveLauncherCliModel } from "./resolve-cli-model.js";
import { buildLauncherResourceLoaderOptions } from "./resource-loader-options.js";
import { buildLauncherSessionOptions } from "./session-options.js";

export type LauncherSessionCreateOptions = Pick<
  CreateAgentSessionFromServicesOptions,
  "model" | "thinkingLevel" | "tools" | "excludeTools" | "noTools"
>;

export interface LauncherRuntimeFactoryOptions {
  authStorage: AuthStorage;
  extensionFlagValues: Map<string, boolean | string>;
  extensionFactories: ExtensionFactory[];
  parsed: Args;
  /** Observes resolved session options immediately before session creation (tests). */
  observeSessionOptions?: (options: LauncherSessionCreateOptions) => void;
  /** Observes SettingsManager after creation (tests). */
  observeSettingsManager?: (settingsManager: SettingsManager) => void;
}

/** Runtime factory for launcher-owned pi-lhc: recreates cwd-bound services on each session replacement. */
export function createLauncherRuntimeFactory(options: LauncherRuntimeFactoryOptions): CreateAgentSessionRuntimeFactory {
  const {
    authStorage,
    extensionFlagValues,
    extensionFactories,
    parsed,
    observeSessionOptions,
    observeSettingsManager,
  } = options;

  return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
    const projectTrusted = parsed.projectTrustOverride ?? (!hasTrustRequiringProjectResources(cwd) ? true : undefined);
    const settingsManager = SettingsManager.create(
      cwd,
      agentDir,
      projectTrusted === undefined ? {} : { projectTrusted },
    );
    observeSettingsManager?.(settingsManager);

    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      authStorage,
      settingsManager,
      extensionFlagValues,
      resourceLoaderOptions: buildLauncherResourceLoaderOptions(parsed, cwd, extensionFactories),
    });

    const resolvedModel = resolveLauncherCliModel(parsed, services.modelRegistry);
    const {
      sessionOptions,
      cliThinkingFromModel,
      diagnostics: sessionOptionDiagnostics,
    } = buildLauncherSessionOptions(parsed, resolvedModel);
    diagnostics.push(...sessionOptionDiagnostics);

    if (parsed.apiKey) {
      if (!sessionOptions.model) {
        diagnostics.push({
          type: "error",
          message: "--api-key requires a model to be specified via --model or --provider/--model",
        });
      } else {
        authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
      }
    }

    if (parsed.name !== undefined) {
      const name = parsed.name.trim();
      if (name === "") {
        diagnostics.push({
          type: "error",
          message: "--name requires a non-empty value",
        });
      } else {
        sessionManager.appendSessionInfo(name);
      }
    }

    observeSessionOptions?.(sessionOptions);

    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...sessionOptions,
      ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
    });

    const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
    if (created.session.model && cliThinkingOverride) {
      created.session.setThinkingLevel(created.session.thinkingLevel);
    }

    return {
      ...created,
      services,
      diagnostics: [...services.diagnostics, ...diagnostics],
    };
  };
}
