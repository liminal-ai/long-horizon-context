// TC-5.1..5.3. Startup validation tests.
//
// TC-5.1: Inference-backed assignments validated against registry before first use.
// TC-5.2: Unreachable lane reported with kind+pair+fix; appears headless.
// TC-5.3: Validation failure leaves capture running; affected derivations fail classified + queryable.

import type { ModelAssignment, SdkConfig } from "lhc";
import { describe, expect, it, vi } from "vitest";
import {
  ASSIGNMENT_KINDS,
  type AssignmentKind,
  DEFAULT_PI_MODEL,
  DEFAULT_ASSIGNMENT_PROMPTS as DEFAULT_PROMPT_NAMES,
  defaultAssignments,
} from "../../src/inference/model-call.js";
import { report, validateReachable } from "../../src/inference/startup-validation.js";
import type { SessionState } from "../../src/lifecycle/state.js";
import type { ExtensionContext, ModelHandle } from "../../src/pi/types.js";
import { fakeModelCallFailure, fakeModelCallRouter, fakeModelCallText } from "../fixtures/model-call.js";
import { tempStore } from "../fixtures/thread.js";

const quietReporter = () => {};

/** Create a minimal ExtensionContext for testing. */
function createMockContext(
  availableModels: ModelHandle[] = [],
  findResult?: ModelHandle | undefined,
  hasAuthResult: boolean = true,
): ExtensionContext {
  const models =
    availableModels.length > 0 ? availableModels : [{ provider: DEFAULT_PI_MODEL.provider, id: DEFAULT_PI_MODEL.id }];

  return {
    cwd: "/test",
    hasUI: false,
    modelRegistry: {
      find:
        findResult !== undefined
          ? () => findResult
          : (provider: string, model: string) => models.find((m) => m.provider === provider && m.id === model),
      hasConfiguredAuth: () => hasAuthResult,
      getAvailable: () => models,
    },
    ui: { notify: () => {} },
    sessionManager: { getEntries: () => [] },
  };
}

/** Create minimal assignments for testing. */
function createAssignments(
  overrides: Partial<Record<AssignmentKind, ModelAssignment>> = {},
): Record<AssignmentKind, ModelAssignment> {
  const base = defaultAssignments();
  return { ...base, ...overrides };
}

describe("Story 6: Startup Validation and Assignment Config", () => {
  describe("TC-5.1: Inference-backed assignments validated against registry before first use", () => {
    it("validates all inference-backed assignments when all lanes are reachable", () => {
      const models: ModelHandle[] = [
        { provider: "openai", id: "gpt-4o" },
        { provider: "anthropic", id: "claude-3-opus" },
      ];

      const ctx = createMockContext(models, models[0], true);
      const assignments = createAssignments({
        smoothed_prompt: { provider: "openai", model: "gpt-4o", prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt },
        smooth_turn_compression: {
          provider: "anthropic",
          model: "claude-3-opus",
          prompt: DEFAULT_PROMPT_NAMES.smooth_turn_compression,
        },
      });

      const report = validateReachable(assignments, ctx);

      // All lanes reachable - empty unreachable array
      expect(report.unreachable).toHaveLength(0);
    });

    it("validates all inference-backed kinds even when only some are overridden", () => {
      const models: ModelHandle[] = [{ provider: "openai", id: "gpt-4o" }];
      // Don't pass findResult - let the mock use the array lookup (so defaults won't be found)
      const ctx = createMockContext(models, undefined, true);

      // Override one kind, others use shipped defaults.
      const assignments = createAssignments({
        smoothed_prompt: { provider: "openai", model: "gpt-4o", prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt },
      });

      const report = validateReachable(assignments, ctx);

      // Should report unreachable for the non-overridden inference-backed kinds.
      expect(report.unreachable).toHaveLength(ASSIGNMENT_KINDS.length - 1);
    });

    it("shipped defaults validate through a real PI modelRegistry lane", () => {
      const defaultHandle: ModelHandle = { provider: DEFAULT_PI_MODEL.provider, id: DEFAULT_PI_MODEL.id };
      const findMock = vi.fn((provider: string, model: string) =>
        provider === DEFAULT_PI_MODEL.provider && model === DEFAULT_PI_MODEL.id ? defaultHandle : undefined,
      );
      const ctx = createMockContext([defaultHandle], undefined, true);
      ctx.modelRegistry.find = findMock;

      const validationReport = validateReachable(createAssignments(), ctx);

      expect(validationReport.unreachable).toHaveLength(0);
      for (const kind of ASSIGNMENT_KINDS) {
        expect(findMock).toHaveBeenCalledWith(createAssignments()[kind].provider, createAssignments()[kind].model);
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
        smoothed_prompt: {
          provider: "unknown-provider",
          model: "unknown-model",
          prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt,
        },
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
        smooth_turn_compression: {
          provider: "openai",
          model: "gpt-4o",
          prompt: DEFAULT_PROMPT_NAMES.smooth_turn_compression,
        },
      });

      const report = validateReachable(assignments, ctx);

      const toolEntry = report.unreachable.find((e) => e.kind === "smooth_turn_compression");
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
        smoothed_prompt: {
          provider: "anthropic",
          model: "claude-3-opus",
          prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt,
        },
      });
      const assignmentsWithoutModel = createAssignments({
        smooth_turn_compression: {
          provider: "unknown",
          model: "unknown",
          prompt: DEFAULT_PROMPT_NAMES.smooth_turn_compression,
        },
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

      const reporter = vi.fn();

      // Report should not throw even in headless mode
      expect(() => report(validationReport, ctx, state, { reporter })).not.toThrow();

      // State should have the report persisted with headless-visible text.
      expect(state.health.startupValidation?.unreachable).toBe(validationReport.unreachable);
      expect(state.health.startupValidation?.message).toContain("unreachable derivation lanes");
      expect(state.health.startupValidation?.message).toContain("smoothed_prompt");
      expect(state.flags.startupValidationReported).toBe(true);

      // No UI notification in headless mode (hasUI=false).
      expect(notifySpy).not.toHaveBeenCalled();
      expect(reporter).toHaveBeenCalledTimes(1);
      const loggedMessage = reporter.mock.calls[0]?.[0]?.message ?? "";
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
        smooth_turn_compression: {
          provider: "unknown2",
          model: "model2",
          prompt: DEFAULT_PROMPT_NAMES.smooth_turn_compression,
        },
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
      expect(notifyMessage).toContain("smooth_turn_compression");
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
      expect(() => report(validationReport, ctx, state, { reporter: quietReporter })).not.toThrow();

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
          smoothed_prompt: { provider: "openai", model: "gpt-4o", prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt },
          smooth_turn_compression: {
            provider: "unknown",
            model: "unknown",
            prompt: DEFAULT_PROMPT_NAMES.smooth_turn_compression,
          },
          tool_result_summary: {
            provider: "openai",
            model: "gpt-4o",
            prompt: DEFAULT_PROMPT_NAMES.tool_result_summary,
          },
          chunk_summary_brief: {
            provider: "openai",
            model: "gpt-4o",
            prompt: DEFAULT_PROMPT_NAMES.chunk_summary_brief,
          },
        });

        // Build SDK config with these assignments
        const { createConnector: createConn } = await import("../../src/index.js");
        const { makeUserMessage, makeAssistantMessage } = await import("../fixtures/synthetic.js");

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
          startupValidationReporter: quietReporter,
        });

        // Start session - validation runs and reports unreachable lane
        await connector.handlers.session_start(ctx, { reason: "new" });
        const instance = connector.getInstance();
        const state = connector.getState();

        expect(instance).not.toBeNull();
        expect(state).not.toBeNull();
        if (instance === null || state === null) return;

        // Verify validation reported the unreachable lane (smooth_turn_compression)
        expect(state.health.startupValidation).toBeDefined();
        expect(state.health.startupValidation?.unreachable.length).toBeGreaterThan(0);
        const smoothEntry = state.health.startupValidation?.unreachable.find(
          (e) => e.kind === "smooth_turn_compression",
        );
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

        // Verify that smooth_turn_compression derivations failed classified (unreachable lane)
        const compressionFailed = health.value.owners.some(
          (o) => o.kind === "smooth_turn_compression" && o.counts.failed > 0,
        );
        expect(compressionFailed).toBe(true);

        // Verify failures are queryable through health
        expect(health.value.failures.length).toBeGreaterThan(0);
        const compressionFailure = health.value.failures.find((f) => f.derivationType === "smooth_turn_compression");
        expect(compressionFailure).toBeDefined();
        expect(compressionFailure?.reason).toContain("invalid_request");
        expect(compressionFailure?.lastError).toContain("unreachable assignment lane");

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

      report(validationReport, ctx, state, { reporter: quietReporter });

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

      report(validationReport, ctx, state, { reporter: quietReporter });

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
      expect(() => report(emptyReport, ctx, state, { reporter: quietReporter })).not.toThrow();
      expect(() => report(fullReport, ctx, state, { reporter: quietReporter })).not.toThrow();

      // State should be updated in both cases
      expect(state.health.startupValidation).toBeDefined();
      expect(state.flags.startupValidationReported).toBe(true);
    });
  });
});
