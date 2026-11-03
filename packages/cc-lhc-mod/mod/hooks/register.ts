import type { Register } from "claude-code";
import { captureStep, captureTurnStart, registerCapture } from "./capture.ts";
import { checkPressureOnce, registerCompact } from "./compact.ts";
import { measureCheck, measureResponse } from "./measure.ts";
import { applySettings, appliedPolicy, hasModelChanged, setOption, setOptions } from "./policy.ts";
import { registerRetrieval, registerRetrievalTools } from "./retrieval.ts";
import { bind, boundSession, startSidecar } from "./sidecar.ts";

export const register: Register = (on, initial) => {
  setOptions(initial);
  registerCapture(on);
  registerCompact(on);
  registerRetrieval(on);

  on("session.start", async ($, e, next) => {
    const started = await next(e);
    void startSidecar($).catch(() => {});
    await registerRetrievalTools($);
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
    if (e.agentId === undefined) measureResponse(result.usage);
    return result;
  });

  on("config.set", async ($, e, next) => {
    const written = await next(e);
    const field = e.key.startsWith("lhc.") ? e.key.slice("lhc.".length) : undefined;
    if (field !== undefined && "value" in written) {
      setOption(field, written.value);
      applySettings($, "config");
    }
    return written;
  });
};
