// TC-4.1..4.4. Model call function tests.
//
// TC-4.1: Function resolves (provider,model) via registry, returns text.
// TC-4.2: Two kinds → different (provider,model) both route in one session.
// TC-4.3: Failure shapes map to exact kinds (adapter-boundary risk test).
// TC-4.4: Resolved-but-no-output → empty_output by adapter (not host fn).
//
// These tests use synthetic PI contexts (mock-free at the boundary) and assert
// on the ModelCallResult shapes, exercising classification and routing without
// a live provider.

import { initLhc, type ModelCallInput, threads } from "lhc";
import { describe, expect, it, vi } from "vitest";
import { classifyFailure, createModelCall, defaultAssignments } from "../../src/inference/model-call.js";
import type { PiAiComplete } from "../../src/inference/pi-ai.js";
import type { ExtensionContext, ModelHandle } from "../../src/pi/types.js";
import { validEvent } from "../fixtures/synthetic.js";
import { tempStore } from "../fixtures/thread.js";

const INPUT: ModelCallInput = {
  provider: "openai-codex",
  model: "gpt-5.4-mini",
  messages: [{ role: "user", content: "hi" }],
};

describe("Story 5: Inference Host Routing", () => {
  describe("TC-4.1: ModelCall resolves provider/model and returns text", () => {
    it("resolves a known model with configured auth and returns completion text", async () => {
      const mockHandle: ModelHandle = { provider: "openai-codex", id: "gpt-5.4-mini" };
      const ctx: ExtensionContext = {
        cwd: "/test",
        hasUI: false,
        modelRegistry: {
          find: () => mockHandle,
          hasConfiguredAuth: () => true,
          getAvailable: () => [mockHandle],
        },
        ui: { notify: () => {} },
        sessionManager: { getEntries: () => [] },
      };

      const complete = vi.fn<PiAiComplete>(async (model) => ({
        role: "assistant",
        content: [{ type: "text", text: `real completion from ${model.provider}/${model.id}` }],
      }));
      const modelCall = createModelCall(ctx, { complete });
      const result = await modelCall(INPUT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe("real completion from openai-codex/gpt-5.4-mini");
      }
      expect(complete).toHaveBeenCalledWith(mockHandle, { messages: INPUT.messages }, undefined);
    });

    it("passes registry-resolved request auth into complete() without exposing tokens in assertions", async () => {
      const mockHandle: ModelHandle = { provider: "openai-codex", id: "gpt-5.4-mini" };
      const oauthToken = "oauth-access-token-fixture";
      const ctx: ExtensionContext = {
        cwd: "/test",
        hasUI: false,
        modelRegistry: {
          find: () => mockHandle,
          hasConfiguredAuth: () => true,
          getApiKeyAndHeaders: async () => ({
            ok: true as const,
            apiKey: oauthToken,
            headers: { Authorization: `Bearer ${oauthToken}` },
          }),
          getAvailable: () => [mockHandle],
        },
        ui: { notify: () => {} },
        sessionManager: { getEntries: () => [] },
      };

      const complete = vi.fn<PiAiComplete>(async () => ({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      }));
      const modelCall = createModelCall(ctx, { complete });
      await modelCall(INPUT);

      expect(complete).toHaveBeenCalledWith(
        mockHandle,
        { messages: INPUT.messages },
        expect.objectContaining({
          apiKey: expect.any(String),
          headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Bearer /) }),
        }),
      );
      const passedOptions = complete.mock.calls[0]?.[2];
      const resolvedAuth = await ctx.modelRegistry.getApiKeyAndHeaders?.(mockHandle);
      expect(resolvedAuth?.ok).toBe(true);
      if (resolvedAuth?.ok !== true) return;
      expect(passedOptions?.apiKey).toBe(resolvedAuth.apiKey);
      expect(passedOptions?.headers).toEqual(resolvedAuth.headers);
    });

    it("awaits async getApiKeyAndHeaders before calling complete", async () => {
      const mockHandle: ModelHandle = { provider: "openai-codex", id: "gpt-5.4-mini" };
      let releaseAuth: (() => void) | undefined;
      const authGate = new Promise<void>((resolve) => {
        releaseAuth = resolve;
      });
      const ctx: ExtensionContext = {
        cwd: "/test",
        hasUI: false,
        modelRegistry: {
          find: () => mockHandle,
          hasConfiguredAuth: () => true,
          getApiKeyAndHeaders: async () => {
            await authGate;
            return { ok: true as const, apiKey: "delayed-oauth-token" };
          },
          getAvailable: () => [mockHandle],
        },
        ui: { notify: () => {} },
        sessionManager: { getEntries: () => [] },
      };

      const complete = vi.fn<PiAiComplete>(async () => ({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      }));
      const modelCall = createModelCall(ctx, { complete });
      const pending = modelCall(INPUT);
      await Promise.resolve();
      expect(complete).not.toHaveBeenCalled();
      releaseAuth?.();
      await pending;
      expect(complete).toHaveBeenCalledWith(
        mockHandle,
        { messages: INPUT.messages },
        expect.objectContaining({ apiKey: "delayed-oauth-token" }),
      );
    });

    it("maps getApiKeyAndHeaders ok:false to auth failure preserving error", async () => {
      const ctx: ExtensionContext = {
        cwd: "/test",
        hasUI: false,
        modelRegistry: {
          find: () => ({ provider: "openai-codex", id: "gpt-5.4-mini" }),
          hasConfiguredAuth: () => true,
          getApiKeyAndHeaders: async () => ({
            ok: false as const,
            error: "OAuth token refresh failed",
          }),
          getAvailable: () => [],
        },
        ui: { notify: () => {} },
        sessionManager: { getEntries: () => [] },
      };

      const complete = vi.fn<PiAiComplete>();
      const result = await createModelCall(ctx, { complete })(INPUT);

      expect(result).toEqual({
        ok: false,
        kind: "auth",
        message: "OAuth token refresh failed",
      });
      expect(complete).not.toHaveBeenCalled();
    });
    it("passes thinking none to pi-ai as reasoningEffort none", async () => {
      const mockHandle: ModelHandle = { provider: "openai-codex", id: "gpt-5.4-mini" };
      const ctx: ExtensionContext = {
        cwd: "/test",
        hasUI: false,
        modelRegistry: {
          find: () => mockHandle,
          hasConfiguredAuth: () => true,
          getAvailable: () => [mockHandle],
        },
        ui: { notify: () => {} },
        sessionManager: { getEntries: () => [] },
      };

      const complete = vi.fn<PiAiComplete>(async () => ({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      }));
      const modelCall = createModelCall(ctx, { complete });
      await modelCall({ ...INPUT, thinking: "none" });

      expect(complete).toHaveBeenCalledWith(mockHandle, { messages: INPUT.messages }, { reasoningEffort: "none" });
    });

    it("defaultAssignments use gpt-5.4-mini with thinking none for every inference kind", () => {
      const assignments = defaultAssignments();
      for (const kind of [
        "smoothed_prompt",
        "tool_result_summary",
        "smooth_turn_compression",
        "chunk_summary_brief",
      ] as const) {
        expect(assignments[kind]).toMatchObject({
          provider: "openai-codex",
          model: "gpt-5.4-mini",
          thinking: "none",
        });
      }
    });
  });

  describe("TC-4.2: Multi-lane routing — different kinds route to different pairs", () => {
    it("routes each call by its provider/model keys independently", async () => {
      const handles: ModelHandle[] = [
        { provider: "openai-codex", id: "gpt-5.4" },
        { provider: "anthropic", id: "claude-3-opus" },
        { provider: "openai", id: "gpt-4o" },
      ];

      const findMock = vi.fn((provider: string, model: string) =>
        handles.find((h) => h.provider === provider && h.id === model),
      ) as (provider: string, model: string) => ModelHandle | undefined;

      const ctx: ExtensionContext = {
        cwd: "/test",
        hasUI: false,
        modelRegistry: {
          find: findMock,
          hasConfiguredAuth: () => true,
          getAvailable: () => handles,
        },
        ui: { notify: () => {} },
        sessionManager: { getEntries: () => [] },
      };

      const modelCall = createModelCall(ctx, {
        complete: async (resolved) => ({
          role: "assistant",
          content: [{ type: "text", text: `routed ${resolved.provider}/${resolved.id}` }],
        }),
      });

      // Call with different provider/model pairs
      const result1 = await modelCall({
        ...INPUT,
        provider: "openai-codex",
        model: "gpt-5.4",
      });
      const result2 = await modelCall({
        ...INPUT,
        provider: "anthropic",
        model: "claude-3-opus",
      });
      const result3 = await modelCall({
        ...INPUT,
        provider: "openai",
        model: "gpt-4o",
      });

      // All should succeed and route correctly
      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      expect(result3.ok).toBe(true);

      // Verify find was called with the correct keys
      expect(findMock).toHaveBeenCalledWith("openai-codex", "gpt-5.4");
      expect(findMock).toHaveBeenCalledWith("anthropic", "claude-3-opus");
      expect(findMock).toHaveBeenCalledWith("openai", "gpt-4o");
    });
  });

  describe("TC-4.3: Adapter-boundary risk — failure shapes map to exact kinds", () => {
    describe("terminal failures", () => {
      it("classifies auth failure as terminal", async () => {
        const ctx: ExtensionContext = {
          cwd: "/test",
          hasUI: false,
          modelRegistry: {
            find: () => ({ provider: "openai-codex", id: "gpt-5.4" }),
            hasConfiguredAuth: () => false, // No auth configured
            getAvailable: () => [],
          },
          ui: { notify: () => {} },
          sessionManager: { getEntries: () => [] },
        };

        const modelCall = createModelCall(ctx);
        const result = await modelCall(INPUT);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.kind).toBe("auth");
        }
      });

      it("classifies invalid_request as terminal", async () => {
        const ctx: ExtensionContext = {
          cwd: "/test",
          hasUI: false,
          modelRegistry: {
            find: () => undefined, // Model not found
            hasConfiguredAuth: () => true,
            getAvailable: () => [],
          },
          ui: { notify: () => {} },
          sessionManager: { getEntries: () => [] },
        };

        const modelCall = createModelCall(ctx);
        const result = await modelCall(INPUT);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.kind).toBe("invalid_request");
        }
      });
    });

    describe("retryable failures", () => {
      it("classifies rate_limit error as retryable", () => {
        const error = { code: "rate_limit_exceeded", message: "Rate limit exceeded" };
        const kind = classifyFailure(error);
        expect(kind).toBe("rate_limit");
      });

      it("classifies timeout error as retryable", () => {
        const error = { code: "request_timeout", message: "Request timed out" };
        const kind = classifyFailure(error);
        expect(kind).toBe("timeout");
      });

      it("classifies network error as retryable", () => {
        const error = { code: "network_error", message: "Connection failed" };
        const kind = classifyFailure(error);
        expect(kind).toBe("network");
      });
    });

    describe("thrown exception maps to other", () => {
      it("classifies a thrown generic error as other", () => {
        const error = new Error("Something went wrong");
        const kind = classifyFailure(error);
        expect(kind).toBe("other");
      });

      it("classifies a non-error throw as other", () => {
        const kind = classifyFailure("string error");
        expect(kind).toBe("other");
      });

      it("classifies null as other", () => {
        const kind = classifyFailure(null);
        expect(kind).toBe("other");
      });
    });

    describe("error pattern matching", () => {
      it("recognizes auth patterns in code, type, and message", () => {
        expect(classifyFailure({ code: "auth_failed" })).toBe("auth");
        expect(classifyFailure({ type: "authentication_error" })).toBe("auth");
        expect(classifyFailure({ message: "Unauthorized access" })).toBe("auth");
        expect(classifyFailure({ code: "401" })).toBe("auth");
      });

      it("recognizes invalid_request patterns", () => {
        expect(classifyFailure({ code: "invalid_request" })).toBe("invalid_request");
        expect(classifyFailure({ code: "400" })).toBe("invalid_request");
        expect(classifyFailure({ message: "Bad request" })).toBe("invalid_request");
      });

      it("recognizes rate_limit patterns", () => {
        expect(classifyFailure({ code: "rate_limit" })).toBe("rate_limit");
        expect(classifyFailure({ code: "429" })).toBe("rate_limit");
        expect(classifyFailure({ type: "rate_limit_exceeded" })).toBe("rate_limit");
      });

      it("recognizes timeout patterns", () => {
        expect(classifyFailure({ code: "timeout" })).toBe("timeout");
        expect(classifyFailure({ code: "408" })).toBe("timeout");
        expect(classifyFailure({ message: "Request timed out" })).toBe("timeout");
      });

      it("recognizes network patterns", () => {
        expect(classifyFailure({ code: "network_error" })).toBe("network");
        expect(classifyFailure({ code: "ECONNREFUSED" })).toBe("network");
        expect(classifyFailure({ type: "connection_error" })).toBe("network");
      });
    });
  });

  describe("TC-4.4: Host returns text-or-transport-failure; adapter owns empty_output", () => {
    it("returns ok:true with empty text when completion produces no output", async () => {
      const ctx: ExtensionContext = {
        cwd: "/test",
        hasUI: false,
        modelRegistry: {
          find: () => ({ provider: "openai-codex", id: "gpt-5.4" }),
          hasConfiguredAuth: () => true,
          getAvailable: () => [],
        },
        ui: { notify: () => {} },
        sessionManager: { getEntries: () => [] },
      };

      const modelCall = createModelCall(ctx, {
        complete: async () => ({ role: "assistant", content: [] }),
      });
      const result = await modelCall(INPUT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe("");
      }
    });

    it("LHC adapter classifies empty resolved output as empty_output", async () => {
      const store = tempStore();
      try {
        const sdk = initLhc({
          inference: {
            call: async () => ({ ok: true, text: "" }),
            assignments: defaultAssignments({ provider: "openai-codex", id: "gpt-5.4" }),
          },
          mode: "manual",
          retry: { budget: 1, backoffBaseMs: 0, backoffCapMs: 0 },
        });
        const created = await threads.newThread({
          filePath: store.threadPath(),
          registryPath: store.registryPath,
        });
        expect(created.ok).toBe(true);
        if (!created.ok) return;

        const captured = await sdk.intakeStream.messageEvents({ filePath: created.value.filePath }, [
          validEvent("user_prompt", {
            idempotencyKey: "empty-output-prompt",
            payload: { text: "produce no output" },
          }),
        ]);
        expect(captured.ok).toBe(true);

        const drained = await sdk.work.drain({ filePath: created.value.filePath });
        expect(drained.ok).toBe(true);
        const health = await sdk.inspect.health({ filePath: created.value.filePath });
        expect(health.ok).toBe(true);
        if (health.ok) {
          const failures = health.value.failures.filter((f) => f.derivationType === "smoothed_prompt");
          expect(failures).toEqual([
            expect.objectContaining({
              reason: expect.stringContaining("empty_output"),
              lastError: expect.stringContaining("empty_output"),
            }),
          ]);
        }
      } finally {
        store.cleanup();
      }
    });
  });

  describe("TC-4.5: Provider error responses stay failures at the host boundary", () => {
    it("maps stopReason error with empty content to ok:false preserving errorMessage", async () => {
      const ctx: ExtensionContext = {
        cwd: "/test",
        hasUI: false,
        modelRegistry: {
          find: () => ({ provider: "openai-codex", id: "gpt-5.4-mini" }),
          hasConfiguredAuth: () => true,
          getAvailable: () => [],
        },
        ui: { notify: () => {} },
        sessionManager: { getEntries: () => [] },
      };

      const modelCall = createModelCall(ctx, {
        complete: async () => ({
          role: "assistant",
          stopReason: "error",
          errorMessage: "No API key for provider: openai-codex",
          content: [],
        }),
      });
      const result = await modelCall(INPUT);

      expect(result).toEqual({
        ok: false,
        kind: "auth",
        message: "No API key for provider: openai-codex",
      });
    });

    it("returns ok:true with whitespace-only text for successful completions", async () => {
      const ctx: ExtensionContext = {
        cwd: "/test",
        hasUI: false,
        modelRegistry: {
          find: () => ({ provider: "openai-codex", id: "gpt-5.4" }),
          hasConfiguredAuth: () => true,
          getAvailable: () => [],
        },
        ui: { notify: () => {} },
        sessionManager: { getEntries: () => [] },
      };

      const modelCall = createModelCall(ctx, {
        complete: async () => ({
          role: "assistant",
          content: [{ type: "text", text: "   " }],
        }),
      });
      const result = await modelCall(INPUT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe("   ");
      }
    });
  });
});
