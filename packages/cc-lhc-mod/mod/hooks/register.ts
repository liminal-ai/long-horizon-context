import type { Register } from "claude-code";
import { inferenceLane } from "../../src/inference.ts";
import { captureStep, captureTurnStart, registerCapture } from "./capture.ts";
import { checkPressureOnce, registerCompact } from "./compact.ts";
import { startInferencePump } from "./inference.ts";
import { contextMeasure, measureCheck, measureResponse } from "./measure.ts";
import { registerPanel, registerPanelCommand } from "./panel.tsx";
import { applySettings, appliedPolicy, hasModelChanged, setOption, setOptions } from "./policy.ts";
import { registerRetrieval, registerRetrievalTools } from "./retrieval.ts";
import { bind, boundSession, rebinding, setInference, startSidecar } from "./sidecar.ts";
import { publishBestEffort } from "./state.ts";

export const register: Register = (on, initial) => {
  setOptions(initial);
  const lane = inferenceLane(initial);
  setInference(lane);
  registerCapture(on);
  registerCompact(on);
  registerRetrieval(on);
  registerPanel(on);

  on("session.start", async ($, e, next) => {
    const started = await next(e);
    void startSidecar($).catch(() => {});
    if (lane === "bridge") startInferencePump($);
    await registerRetrievalTools($);
    await registerPanelCommand($);
    const { value: binding } = await $.state.get({ plugin: "lhc", key: "binding" });
    if (binding !== undefined && boundSession() === undefined && binding.sessionId === (await $.session.id())) {
      bind($, rebinding(binding, "reload"));
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
    if (e.agentId === undefined && (await hasModelChanged($))) {
      applySettings($, "model");
    }
    return next(e);
  });

  on("turn.step", async function* ($, e, next) {
    if (e.agentId === undefined) {
      await captureStep($, e.turnId, e.index);
      measureCheck();
      await checkPressureOnce($, appliedPolicy());
    }
    const result = yield* next(e);
    if (e.agentId === undefined) {
      measureResponse(result.usage);
      const context = contextMeasure();
      if (context !== undefined) void publishBestEffort($, { context });
    }
    return result;
  });

  on("config.set", async ($, e, next) => {
    const written = await next(e);
    const field = e.key.startsWith("lhc.") ? e.key.slice("lhc.".length) : undefined;
    const isAlreadyAppliedByPanel = e.origin.kind === "plugin" && e.origin.name === "lhc";
    if (field !== undefined && !isAlreadyAppliedByPanel && "value" in written) {
      setOption(field, written.value);
      applySettings($, "config");
    }
    return written;
  });
};
