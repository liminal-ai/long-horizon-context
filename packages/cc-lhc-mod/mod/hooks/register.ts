import type { EngineInterface, Register } from "claude-code";
import { computePolicy, type ResolvedSettings, resolveSettings } from "../../src/settings.ts";
import { captureTurnStart, registerCapture } from "./capture.ts";
import { bind, boundSession, log, post, runInBackground, startSidecar } from "./sidecar.ts";

let options: Record<string, unknown> = {};
let settings: ResolvedSettings = resolveSettings(options);
let appliedModel: string | undefined;

async function compactWindow($: EngineInterface): Promise<number> {
  const { context } = await $.session.usage({ breakdown: "summary" });
  return context.breakdown?.rawMaxTokens ?? context.window;
}

function applySettings($: EngineInterface, reason: string): void {
  runInBackground($, "applySettings", async () => {
    appliedModel = await $.session.model();
    const { policy, notices } = computePolicy(settings, await compactWindow($));
    for (const notice of notices) $.ui.log(`LHC settings: ${notice}`);
    const set = await $.env.set("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", String(policy.pct));
    if ("deny" in set) throw new Error(`env refused: ${set.deny}`);
    const clamp = policy.isClamped ? " clamped" : "";
    log(
      $,
      `${reason} window ${policy.window} trigger ${policy.trigger} target ${policy.target} pct ${policy.pct}${clamp}`,
    );
    await post($, "/policy", { window: policy.window, trigger: policy.trigger, target: policy.target });
  });
}

export const register: Register = (on, initial) => {
  options = { ...initial };
  settings = resolveSettings(options);
  registerCapture(on);

  on("session.start", async ($, e, next) => {
    const started = await next(e);
    void startSidecar($).catch(() => {});
    const { value: binding } = await $.state.get({ plugin: "lhc", key: "binding" });
    if (binding !== undefined && boundSession() === undefined && binding.sessionId === (await $.session.id())) {
      bind($, { ...binding, source: "reload" });
    }
    applySettings($, "start");
    return started;
  });

  on("classic.SessionStart", async ($, e, next) => {
    bind($, { sessionId: e.session_id, transcriptPath: e.transcript_path, source: e.source });
    applySettings($, "bind");
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined) await captureTurnStart($, e.turnId);
    if (e.agentId === undefined && appliedModel !== undefined && (await $.session.model()) !== appliedModel) {
      applySettings($, "model");
    }
    return next(e);
  });

  on("config.set", async ($, e, next) => {
    const written = await next(e);
    const field = e.key.startsWith("lhc.") ? e.key.slice("lhc.".length) : undefined;
    if (field !== undefined && "value" in written) {
      options = { ...options, [field]: written.value };
      settings = resolveSettings(options);
      applySettings($, "config");
    }
    return written;
  });
};
