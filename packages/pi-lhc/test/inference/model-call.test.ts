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
import { makeAssistantMessage, validEvent } from "../fixtures/synthetic.js";
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

      const complete = vi.fn<PiAiComplete>(async (model) =>
        makeAssistantMessage({ text: `real completion from ${model.provider}/${model.id}` }),
      );
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

      const complete = vi.fn<PiAiComplete>(async () => makeAssistantMessage({ text: "ok" }));
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

    it("applies resolved baseUrl on the model handle passed to complete()", async () => {
      const mockHandle: ModelHandle = { provider: "custom", id: "my-model", baseUrl: "https://default.example" };
      const ctx: ExtensionContext = {
        cwd: "/test",
        hasUI: false,
        modelRegistry: {
          find: () => mockHandle,
          hasConfiguredAuth: () => true,
          getApiKeyAndHeaders: async () => ({
            ok: true as const,
            apiKey: "key",
            baseUrl: "https://gateway.example/v1",
          }),
          getAvailable: () => [mockHandle],
        },
        ui: { notify: () => {} },
        sessionManager: { getEntries: () => [] },
      };

      const complete = vi.fn<PiAiComplete>(async () => makeAssistantMessage({ text: "ok" }));
      const modelCall = createModelCall(ctx, { complete });
      await modelCall({ ...INPUT, provider: "custom", model: "my-model" });

      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "custom", id: "my-model", baseUrl: "https://gateway.example/v1" }),
        { messages: INPUT.messages },
        expect.objectContaining({ apiKey: "key" }),
      );
      // baseUrl is not an option field — it rides on the model (upstream prepareRequest).
      expect(complete.mock.calls[0]?.[2]).not.toHaveProperty("baseUrl");
    });

    it("resolves complete() from @earendil-works/pi-ai/compat against the vendored package", async () => {
      const loaded = await import("@earendil-works/pi-ai/compat");
      expect(typeof loaded.complete).toBe("function");
      // Root export no longer carries complete() after the Models API migration.
      const root = await import("@earendil-works/pi-ai");
      expect((root as { complete?: unknown }).complete).toBeUndefined();
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

      const complete = vi.fn<PiAiComplete>(async () => makeAssistantMessage({ text: "ok" }));
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

    it("does not treat PI 0.84 null header deletion markers as request credentials", async () => {
      const mockHandle: ModelHandle = { provider: "openai-codex", id: "gpt-5.4-mini" };
      const ctx: ExtensionContext = {
        cwd: "/test",
        hasUI: false,
        modelRegistry: {
          find: () => mockHandle,
          hasConfiguredAuth: () => true,
          getApiKeyAndHeaders: async () => ({
            ok: true as const,
            headers: { Authorization: null },
          }),
          getAvailable: () => [mockHandle],
        },
        ui: { notify: () => {} },
        sessionManager: { getEntries: () => [] },
      };

      const complete = vi.fn<PiAiComplete>();
      const result = await createModelCall(ctx, { complete })(INPUT);

      expect(result).toEqual({
        ok: false,
        kind: "auth",
        message: "configured auth for openai-codex/gpt-5.4-mini did not resolve request credentials",
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

      const complete = vi.fn<PiAiComplete>(async () => makeAssistantMessage({ text: "ok" }));
      const modelCall = createModelCall(ctx, { complete });
      await modelCall({ ...INPUT, thinking: "none" });

      expect(complete).toHaveBeenCalledWith(mockHandle, { messages: INPUT.messages }, { reasoningEffort: "none" });
    });

    it("defaultAssignments use gpt-5.4-mini with thinking none for every inference kind", () => {
      const assignments = defaultAssignments();
      for (const kind of [
        "smoothed_prompt",
        "tool_result_summary",
        "detailed_turn_compression",
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
        complete: async (resolved) => makeAssistantMessage({ text: `routed ${resolved.provider}/${resolved.id}` }),
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
        complete: async () => makeAssistantMessage({}),
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
          // HealthReport.failures carries reason only (no lastError field after
          // the one-shot work-queue health surface; classification lives in reason).
          const failures = health.value.failures.filter((f) => f.derivationType === "smoothed_prompt");
          expect(failures).toEqual([
            expect.objectContaining({
              reason: expect.stringContaining("empty_output"),
            }),
          ]);
        }
      } finally {
        store.cleanup();
      }
    });
  });

  describe("system prompt partitioning for pi-ai Context", () => {
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

    it("extracts a leading system message into context.systemPrompt", async () => {
      const complete = vi.fn<PiAiComplete>(async () => makeAssistantMessage({ text: "ok" }));
      const modelCall = createModelCall(ctx, { complete });
      await modelCall({
        ...INPUT,
        messages: [
          { role: "system", content: "You compress turns." },
          { role: "user", content: "hi" },
        ],
      });

      expect(complete).toHaveBeenCalledWith(
        mockHandle,
        {
          systemPrompt: "You compress turns.",
          messages: [{ role: "user", content: "hi" }],
        },
        undefined,
      );
    });

    it("omits systemPrompt when messages contain no system role", async () => {
      const complete = vi.fn<PiAiComplete>(async () => makeAssistantMessage({ text: "ok" }));
      const modelCall = createModelCall(ctx, { complete });
      await modelCall(INPUT);

      const passedContext = complete.mock.calls[0]?.[1];
      expect(passedContext).toEqual({ messages: INPUT.messages });
      expect(passedContext).not.toHaveProperty("systemPrompt");
    });

    it("extracts multiple system messages in order and joins with blank lines", async () => {
      const complete = vi.fn<PiAiComplete>(async () => makeAssistantMessage({ text: "ok" }));
      const modelCall = createModelCall(ctx, { complete });
      await modelCall({
        ...INPUT,
        messages: [
          { role: "system", content: "First instruction." },
          { role: "user", content: "middle" },
          { role: "system", content: "Second instruction." },
          { role: "user", content: "end" },
        ],
      });

      expect(complete).toHaveBeenCalledWith(
        mockHandle,
        {
          systemPrompt: "First instruction.\n\nSecond instruction.",
          messages: [
            { role: "user", content: "middle" },
            { role: "user", content: "end" },
          ],
        },
        undefined,
      );
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
        complete: async () =>
          makeAssistantMessage({
            stopReason: "error",
            errorMessage: "No API key for provider: openai-codex",
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
        complete: async () => makeAssistantMessage({ text: "   " }),
      });
      const result = await modelCall(INPUT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe("   ");
      }
    });
  });
});
