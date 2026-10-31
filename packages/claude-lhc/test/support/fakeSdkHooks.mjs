import { registerHooks } from "node:module";

const fake = new URL("./fakeSdk.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@anthropic-ai/claude-agent-sdk" && context.parentURL !== fake)
      return { url: fake, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
