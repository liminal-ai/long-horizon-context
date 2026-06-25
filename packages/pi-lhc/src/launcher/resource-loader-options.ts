import type { Args, CreateAgentSessionServicesOptions, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { resolveCliPaths } from "./cli-paths.js";

type LauncherResourceLoaderOptions = NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]>;

export function buildLauncherResourceLoaderOptions(
  parsed: Args,
  cwd: string,
  extensionFactories: ExtensionFactory[],
): LauncherResourceLoaderOptions {
  const additionalExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
  const additionalSkillPaths = resolveCliPaths(cwd, parsed.skills);
  const additionalPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
  const additionalThemePaths = resolveCliPaths(cwd, parsed.themes);

  return {
    ...(additionalExtensionPaths !== undefined ? { additionalExtensionPaths } : {}),
    ...(additionalSkillPaths !== undefined ? { additionalSkillPaths } : {}),
    ...(additionalPromptTemplatePaths !== undefined ? { additionalPromptTemplatePaths } : {}),
    ...(additionalThemePaths !== undefined ? { additionalThemePaths } : {}),
    ...(parsed.noExtensions !== undefined ? { noExtensions: parsed.noExtensions } : {}),
    ...(parsed.noSkills !== undefined ? { noSkills: parsed.noSkills } : {}),
    ...(parsed.noPromptTemplates !== undefined ? { noPromptTemplates: parsed.noPromptTemplates } : {}),
    ...(parsed.noThemes !== undefined ? { noThemes: parsed.noThemes } : {}),
    ...(parsed.noContextFiles !== undefined ? { noContextFiles: parsed.noContextFiles } : {}),
    ...(parsed.systemPrompt !== undefined ? { systemPrompt: parsed.systemPrompt } : {}),
    ...(parsed.appendSystemPrompt !== undefined ? { appendSystemPrompt: parsed.appendSystemPrompt } : {}),
    extensionFactories,
  };
}
