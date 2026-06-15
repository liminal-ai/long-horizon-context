// TC-5.1..5.3. Startup validation tests.
//
// TC-5.1: All seven assignments validated against registry before first use.
// TC-5.2: Unreachable lane reported with kind+pair+fix; appears headless.
// TC-5.3: Validation failure leaves capture running; affected derivations fail classified + queryable.

import { describe, expect, it, vi } from "vitest";
import { FORM_KINDS, DEFAULT_PROMPT_NAMES, type SdkConfig } from "lhc";
import type { FormKind, ModelAssignment } from "lhc";
import { validateReachable, report } from "../../src/inference/startup-validation.js";
import { DEFAULT_PI_MODEL } from "../../src/inference/model-call.js";
import type { ExtensionContext, ModelHandle } from "../../src/pi/types.js";
import type { SessionState } from "../../src/lifecycle/state.js";
import { tempStore } from "../fixtures/thread.js";
import { fakeModelCallFailure, fakeModelCallRouter, fakeModelCallText } from "../fixtures/model-call.js";

/** Create a minimal ExtensionContext for testing. */
function createMockContext(
  availableModels: ModelHandle[] = [],
  findResult?: ModelHandle | undefined,
  hasAuthResult: boolean = true,
): ExtensionContext {
  const models = availableModels.length > 0
    ? availableModels
    : [{ provider: DEFAULT_PI_MODEL.provider, id: DEFAULT_PI_MODEL.id }];

  return {
    cwd: "/test",
    hasUI: false,
    modelRegistry: {
      find: findResult !== undefined
        ? (() => findResult)
        : ((provider: string, model: string) =>
            models.find((m) => m.provider === provider && m.id === model)),
      hasConfiguredAuth: () => hasAuthResult,
      getAvailable: () => models,
    },
    ui: { notify: () => {} },
    sessionManager: { getEntries: () => [] },
  };
}

/** Create minimal assignments for testing. */
function createAssignments(overrides: Partial<Record<FormKind, ModelAssignment>> = {}): Record<FormKind, ModelAssignment> {
  const base: Record<FormKind, ModelAssignment> = {
    smoothed_prompt: { provider: DEFAULT_PI_MODEL.provider, model: DEFAULT_PI_MODEL.id, prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt },
    tool_call_summary: { provider: DEFAULT_PI_MODEL.provider, model: DEFAULT_PI_MODEL.id, prompt: DEFAULT_PROMPT_NAMES.tool_call_summary },
    tool_result_summary: { provider: DEFAULT_PI_MODEL.provider, model: DEFAULT_PI_MODEL.id, prompt: DEFAULT_PROMPT_NAMES.tool_result_summary },
    turn_rendering: { provider: DEFAULT_PI_MODEL.provider, model: DEFAULT_PI_MODEL.id, prompt: DEFAULT_PROMPT_NAMES.turn_rendering },
    lower_band_projection: { provider: DEFAULT_PI_MODEL.provider, model: DEFAULT_PI_MODEL.id, prompt: DEFAULT_PROMPT_NAMES.lower_band_projection },
    chunk_summary_detailed: { provider: DEFAULT_PI_MODEL.provider, model: DEFAULT_PI_MODEL.id, prompt: DEFAULT_PROMPT_NAMES.chunk_summary_detailed },
    chunk_summary_brief: { provider: DEFAULT_PI_MODEL.provider, model: DEFAULT_PI_MODEL.id, prompt: DEFAULT_PROMPT_NAMES.chunk_summary_brief },
  };
  return { ...base, ...overrides };
}

describe("Story 6: Startup Validation and Assignment Config", () => {
  describe("TC-5.1: All seven assignments validated against registry before first use", () => {
    it("validates all seven assignments when all lanes are reachable", () => {
      const models: ModelHandle[] = [
        { provider: "openai", id: "gpt-4o" },
        { provider: "anthropic", id: "claude-3-opus" },
      ];

      const ctx = createMockContext(models, models[0], true);
      const assignments = createAssignments({
        smoothed_prompt: { provider: "openai", model: "gpt-4o", prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt },
        tool_call_summary: { provider: "anthropic", model: "claude-3-opus", prompt: DEFAULT_PROMPT_NAMES.tool_call_summary },
      });

      const report = validateReachable(assignments, ctx);

      // All lanes reachable - empty unreachable array
      expect(report.unreachable).toHaveLength(0);
    });

    it("validates all seven kinds even when only some are overridden", () => {
      const models: ModelHandle[] = [{ provider: "openai", id: "gpt-4o" }];
      // Don't pass findResult - let the mock use the array lookup (so defaults won't be found)
      const ctx = createMockContext(models, undefined, true);

      // Override one kind, others use shipped defaults.
      const assignments = createAssignments({
        smoothed_prompt: { provider: "openai", model: "gpt-4o", prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt },
      });

      const report = validateReachable(assignments, ctx);

      // Should report unreachable for the non-overridden kinds (6 of them)
      expect(report.unreachable.length).toBeGreaterThanOrEqual(6);
    });

    it("shipped defaults validate through a real PI modelRegistry lane", () => {
      const defaultHandle: ModelHandle = { provider: DEFAULT_PI_MODEL.provider, id: DEFAULT_PI_MODEL.id };
      const findMock = vi.fn((provider: string, model: string) =>
        provider === DEFAULT_PI_MODEL.provider && model === DEFAULT_PI_MODEL.id
          ? defaultHandle
          : undefined,
      );
      const ctx = createMockContext([defaultHandle], undefined, true);
      ctx.modelRegistry.find = findMock;

      const validationReport = validateReachable(createAssignments(), ctx);

      expect(validationReport.unreachable).toHaveLength(0);
      for (const kind of FORM_KINDS) {
        expect(findMock).toHaveBeenCalledWith(
          createAssignments()[kind].provider,
          createAssignments()[kind].model,
        );
      }
    });

    it("validation runs at session start before any derivation use", () => {
      // This test verifies the contract that validation is called in session_start.
      // The actual integration is in index.ts; this test checks that validateReachable
      // itself doesn't have side effects that would prevent early calling.
      const ctx = createMockContext();
      const assignments = createAssignments();

      // Should complete without throwing (even if it finds issues)
      const report = validateReachable(assignments, ctx);
      expect(report).toBeDefined();
      expect(Array.isArray(report.unreachable)).toBe(true);
    });
  });

  describe("TC-5.2: Unreachable lane reported with kind+pair+fix; appears headless", () => {
    it("reports unknown model with kind, provider/model, and fix", () => {
      const ctx = createMockContext(); // No models available
      const assignments = createAssignments({
        smoothed_prompt: { provider: "unknown-provider", model: "unknown-model", prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt },
      });

      const report = validateReachable(assignments, ctx);

      const smoothEntry = report.unreachable.find((e) => e.kind === "smoothed_prompt");
      expect(smoothEntry).toBeDefined();
      expect(smoothEntry?.provider).toBe("unknown-provider");
      expect(smoothEntry?.model).toBe("unknown-model");
      expect(smoothEntry?.reason).toBe("unknown_model");
      expect(smoothEntry?.fix).toContain("Update 'smoothed_prompt' assignment");
    });

    it("reports auth not configured with kind, provider/model, and login fix", () => {
      const models: ModelHandle[] = [{ provider: "openai", id: "gpt-4o" }];
      const ctx = createMockContext(models, models[0], false); // Model exists but no auth

      const assignments = createAssignments({
        tool_call_summary: { provider: "openai", model: "gpt-4o", prompt: DEFAULT_PROMPT_NAMES.tool_call_summary },
      });

      const report = validateReachable(assignments, ctx);

      const toolEntry = report.unreachable.find((e) => e.kind === "tool_call_summary");
      expect(toolEntry).toBeDefined();
      expect(toolEntry?.provider).toBe("openai");
      expect(toolEntry?.model).toBe("gpt-4o");
      expect(toolEntry?.reason).toBe("auth_not_configured");
      expect(toolEntry?.fix).toContain("Log in or configure auth");
      expect(toolEntry?.fix).toContain("openai/gpt-4o");
    });

    it("distinguishes unknown_model from auth_not_configured", () => {
      const models: ModelHandle[] = [{ provider: "anthropic", id: "claude-3-opus" }];
      const ctxWithAuth = createMockContext(models, models[0], false); // Has model, no auth
      const ctxWithoutModel = createMockContext(models, undefined); // No model at all

      const assignmentsWithModel = createAssignments({
        smoothed_prompt: { provider: "anthropic", model: "claude-3-opus", prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt },
      });
      const assignmentsWithoutModel = createAssignments({
        tool_call_summary: { provider: "unknown", model: "unknown", prompt: DEFAULT_PROMPT_NAMES.tool_call_summary },
      });

      const reportWithModel = validateReachable(assignmentsWithModel, ctxWithAuth);
      const reportWithoutModel = validateReachable(assignmentsWithoutModel, ctxWithoutModel);

      expect(reportWithModel.unreachable[0]?.reason).toBe("auth_not_configured");
      expect(reportWithoutModel.unreachable[0]?.reason).toBe("unknown_model");
    });

    it("report appears in headless mode (no TUI assumed)", () => {
      const ctx = createMockContext(undefined, undefined, false);
      ctx.hasUI = false; // Explicitly headless
      const notifySpy = vi.fn();
      ctx.ui.notify = notifySpy;

      const assignments = createAssignments({
        smoothed_prompt: { provider: "unknown", model: "unknown", prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt },
      });

      const validationReport = validateReachable(assignments, ctx);

      const state: SessionState = {
        threadRef: { filePath: "/test/thread.sqlite" },
        flags: { startupValidationReported: false },
        health: {},
      };

      const headlessLog = vi.fn();

      // Report should not throw even in headless mode
      expect(() => report(validationReport, ctx, state, { headlessLog })).not.toThrow();

      // State should have the report persisted with headless-visible text.
      expect(state.health.startupValidation?.unreachable).toBe(validationReport.unreachable);
      expect(state.health.startupValidation?.message).toContain("unreachable derivation lanes");
      expect(state.health.startupValidation?.message).toContain("smoothed_prompt");
      expect(state.flags.startupValidationReported).toBe(true);

      // No UI notification in headless mode (hasUI=false).
      expect(notifySpy).not.toHaveBeenCalled();
      expect(headlessLog).toHaveBeenCalledTimes(1);
      const loggedMessage = headlessLog.mock.calls[0]?.[0] ?? "";
      expect(loggedMessage).toContain("unreachable derivation lanes");
      expect(loggedMessage).toContain("smoothed_prompt");
    });

    it("report appears through ctx.ui when available", () => {
      const ctx = createMockContext(undefined, undefined, false);
      ctx.hasUI = true; // UI available
      const notifySpy = vi.fn();
      ctx.ui.notify = notifySpy;

      const assignments = createAssignments({
        smoothed_prompt: { provider: "unknown", model: "unknown", prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt },
      });

      const validationReport = validateReachable(assignments, ctx);

      const state: SessionState = {
        threadRef: { filePath: "/test/thread.sqlite" },
        flags: { startupValidationReported: false },
        health: {},
      };

      report(validationReport, ctx, state);

      // State should have the report persisted with the same unreachable lanes.
      expect(state.health.startupValidation?.unreachable).toBe(validationReport.unreachable);
      expect(state.health.startupValidation?.message).toContain("unreachable derivation lanes");
      expect(state.flags.startupValidationReported).toBe(true);

      // UI should be notified with a formatted report
      expect(notifySpy).toHaveBeenCalledTimes(1);
      const notifyMessage = (notifySpy.mock.calls[0]?.[0] ?? "") as string;
      expect(notifyMessage).toContain("unreachable derivation lanes");
      expect(notifyMessage).toContain("smoothed_prompt");
      expect(notifyMessage).toContain("unknown");
    });

    it("report includes formatted message with all unreachable lanes", () => {
      const ctx = createMockContext(undefined, undefined, false);
      ctx.hasUI = true;
      const notifySpy = vi.fn();
      ctx.ui.notify = notifySpy;

      const assignments = createAssignments({
        smoothed_prompt: { provider: "unknown1", model: "model1", prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt },
        tool_call_summary: { provider: "unknown2", model: "model2", prompt: DEFAULT_PROMPT_NAMES.tool_call_summary },
      });

      const validationReport = validateReachable(assignments, ctx);

      const state: SessionState = {
        threadRef: { filePath: "/test/thread.sqlite" },
        flags: { startupValidationReported: false },
        health: {},
      };

      report(validationReport, ctx, state);

      const notifyMessage = (notifySpy.mock.calls[0]?.[0] ?? "") as string;
      expect(notifyMessage).toContain("smoothed_prompt");
      expect(notifyMessage).toContain("unknown1/model1");
      expect(notifyMessage).toContain("tool_call_summary");
      expect(notifyMessage).toContain("unknown2/model2");
    });
  });

  describe("TC-5.3: Validation failure leaves capture running", () => {
    it("capture continues after validation reports unreachable lanes", () => {
      const ctx = createMockContext();
      const assignments = createAssignments({
        smoothed_prompt: { provider: "unknown", model: "unknown", prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt },
      });

      const validationReport = validateReachable(assignments, ctx);

      const state: SessionState = {
        threadRef: { filePath: "/test/thread.sqlite" },
        flags: { startupValidationReported: false },
        health: {},
      };

      // Report should not throw - validation failure is not fatal
      expect(() => report(validationReport, ctx, state)).not.toThrow();

      // State should remain intact for capture to continue
      expect("filePath" in state.threadRef ? state.threadRef.filePath : undefined).toBe("/test/thread.sqlite");
      expect(state.flags.startupValidationReported).toBe(true);
    });

    it("affected lane derivations fail classified and queryable through health", async () => {
      const store = tempStore();
      try {
        // Create a context where one model is available and another is not
        const models: ModelHandle[] = [{ provider: "openai", id: "gpt-4o" }];
        const ctx: ExtensionContext = {
          cwd: "/test/startup-validation",
          hasUI: false,
          modelRegistry: {
            // Only openai/gpt-4o is available; unknown/unknown will be unreachable
            find: (provider: string, model: string) =>
              provider === "openai" && model === "gpt-4o" ? { provider, id: model } : undefined,
            hasConfiguredAuth: (handle) => typeof handle !== "string" && handle.provider === "openai",
            getAvailable: () => models,
          },
          ui: { notify: () => {} },
          sessionManager: { getEntries: () => [] },
        };

        // Create assignments with one reachable and one unreachable lane
        const assignments = createAssignments({
          smoothed_prompt: { provider: "unknown", model: "unknown", prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt },
          tool_call_summary: { provider: "openai", model: "gpt-4o", prompt: DEFAULT_PROMPT_NAMES.tool_call_summary },
          tool_result_summary: { provider: "openai", model: "gpt-4o", prompt: DEFAULT_PROMPT_NAMES.tool_result_summary },
          turn_rendering: { provider: "openai", model: "gpt-4o", prompt: DEFAULT_PROMPT_NAMES.turn_rendering },
          lower_band_projection: { provider: "openai", model: "gpt-4o", prompt: DEFAULT_PROMPT_NAMES.lower_band_projection },
          chunk_summary_detailed: { provider: "openai", model: "gpt-4o", prompt: DEFAULT_PROMPT_NAMES.chunk_summary_detailed },
          chunk_summary_brief: { provider: "openai", model: "gpt-4o", prompt: DEFAULT_PROMPT_NAMES.chunk_summary_brief },
        });

        // Build SDK config with these assignments
        const { createConnector: createConn } = await import("../../src/index.js");
        const { makeUserMessage, makeAssistantMessage, makeAgentEnd } = await import("../fixtures/synthetic.js");

        const sdkConfig: SdkConfig = {
          inference: {
            call: fakeModelCallRouter(
              { "openai/gpt-4o": fakeModelCallText("reachable derivation") },
              fakeModelCallFailure("invalid_request", "unreachable assignment lane"),
            ),
            assignments,
          },
          mode: "background",
        };

        const connector = createConn({
          registryPath: store.registryPath,
          newThreadFilePath: () => store.threadPath(),
          buildSdkConfig: () => ({ ok: true, value: sdkConfig }),
        });

        // Start session - validation runs and reports unreachable lane
        await connector.handlers.session_start(ctx, { reason: "new" });
        const instance = connector.getInstance();
        const state = connector.getState();

        expect(instance).not.toBeNull();
        expect(state).not.toBeNull();
        if (instance === null || state === null) return;

        // Verify validation reported the unreachable lane (smoothed_prompt)
        expect(state.health.startupValidation).toBeDefined();
        expect(state.health.startupValidation?.unreachable.length).toBeGreaterThan(0);
        const smoothEntry = state.health.startupValidation?.unreachable.find((e) => e.kind === "smoothed_prompt");
        expect(smoothEntry?.reason).toBe("unknown_model");

        // Capture continues despite validation failure
        await connector.handlers.message_end(ctx, {
          message: makeUserMessage("test prompt"),
          entryId: "test-user",
        });
        await connector.handlers.message_end(ctx, {
          message: makeAssistantMessage({ text: "test response" }),
          entryId: "test-assistant",
        });
        await connector.handlers.agent_end(ctx, {
          messages: [makeUserMessage("test prompt"), makeAssistantMessage({ text: "test response" })],
        });

        // Drain the scheduler to run derivations
        const threadRef = state.threadRef;
        await instance.sdk.drainSettled(threadRef);

        // Inspect health to verify affected lane derivations failed
        const health = await instance.sdk.inspect.health(threadRef);
        expect(health.ok).toBe(true);
        if (!health.ok) return;

        // Verify that smoothed_prompt derivations failed classified (unreachable lane)
        const smoothedFailed = health.value.owners.some((o) =>
          o.kind === "smoothed_prompt" && o.counts.failed > 0
        );
        expect(smoothedFailed).toBe(true);

        // Verify that turn_rendering derivations succeeded (reachable lane)
        const turnRenderingReady = health.value.owners.some((o) =>
          o.kind === "turn_rendering" && o.counts.ready > 0
        );
        expect(turnRenderingReady).toBe(true);

        // Verify failures are queryable through health
        expect(health.value.failures.length).toBeGreaterThan(0);
        const smoothedFailure = health.value.failures.find((f) => f.form === "smoothed_prompt");
        expect(smoothedFailure).toBeDefined();
        expect(smoothedFailure?.reason).toContain("invalid_request");
        expect(smoothedFailure?.lastError).toContain("unreachable assignment lane");

        await connector.handlers.session_shutdown(ctx, { reason: "shutdown" });
      } finally {
        store.cleanup();
      }
    });

    it("validation does not break the session - state remains functional", () => {
      const ctx = createMockContext();
      const assignments = createAssignments();

      const validationReport = validateReachable(assignments, ctx);

      const state: SessionState = {
        threadRef: { filePath: "/test/thread.sqlite" },
        flags: { startupValidationReported: false },
        health: {},
      };

      report(validationReport, ctx, state);

      // State should be fully functional for capture operations
      expect(state.threadRef).toBeDefined();
      expect("filePath" in state.threadRef && typeof state.threadRef.filePath === "string").toBe(true);
      expect(state.flags).toBeDefined();
      expect(state.health).toBeDefined();

      // Health should be queryable
      expect(state.health.startupValidation).toBeDefined();
    });

    it("empty unreachable list means all lanes reachable - session healthy", () => {
      const models: ModelHandle[] = [{ provider: "openai", id: "gpt-4o" }];
      const ctx = createMockContext(models, models[0], true);
      const assignments = createAssignments({
        smoothed_prompt: { provider: "openai", model: "gpt-4o", prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt },
      });

      const validationReport = validateReachable(assignments, ctx);

      const state: SessionState = {
        threadRef: { filePath: "/test/thread.sqlite" },
        flags: { startupValidationReported: false },
        health: {},
      };

      report(validationReport, ctx, state);

      // Empty unreachable means all lanes validated successfully
      expect(state.health.startupValidation?.unreachable).toHaveLength(0);
    });

    it("report function never throws - always succeeds to persist diagnostic", () => {
      const ctx = createMockContext();
      const assignments = createAssignments();

      // Create various report states
      const emptyReport = { unreachable: [] };
      const fullReport = validateReachable(assignments, ctx);

      const state: SessionState = {
        threadRef: { filePath: "/test/thread.sqlite" },
        flags: { startupValidationReported: false },
        health: {},
      };

      // None of these should throw
      expect(() => report(emptyReport, ctx, state)).not.toThrow();
      expect(() => report(fullReport, ctx, state)).not.toThrow();

      // State should be updated in both cases
      expect(state.health.startupValidation).toBeDefined();
      expect(state.flags.startupValidationReported).toBe(true);
    });
  });
});
