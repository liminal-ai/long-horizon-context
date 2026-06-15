// TC-5.4..5.6. Assignment loading tests.
//
// TC-5.4: Seven kinds load (provider,model,prompt) with shipped defaults; prompts resolve.
// TC-5.5: Override takes effect next start, no code change.
// TC-5.6: Incomplete/unknown assignment fails loud at init (missing kind, unknown prompt, incomplete, placeholder).

import { describe, expect, it } from "vitest";
import { FORM_KINDS, DEFAULT_PROMPT_NAMES, type FormKind } from "lhc";
import { loadAssignments, AssignmentValidationError } from "../../src/inference/assignments.js";
import { DEFAULT_PI_MODEL } from "../../src/inference/model-call.js";

describe("Story 6: Startup Validation and Assignment Config", () => {
  describe("TC-5.4: Seven kinds load with shipped defaults", () => {
    it("loads all seven kinds with provider, model, and prompt from shipped defaults", () => {
      const assignments = loadAssignments(undefined);

      // All seven kinds are present
      expect(FORM_KINDS.every((kind) => kind in assignments)).toBe(true);

      // Each assignment has provider, model, and prompt
      for (const kind of FORM_KINDS) {
        const assignment = assignments[kind];
        expect(assignment).toBeDefined();
        expect(assignment.provider).toBeDefined();
        expect(assignment.provider).not.toBe("");
        expect(assignment.model).toBeDefined();
        expect(assignment.model).not.toBe("");
        expect(assignment.prompt).toBeDefined();
        expect(assignment.prompt).not.toBe("");
      }
    });

    it("uses a production PI registry lane for shipped defaults", () => {
      const assignments = loadAssignments(undefined);

      for (const kind of FORM_KINDS) {
        expect(assignments[kind].provider).toBe(DEFAULT_PI_MODEL.provider);
        expect(assignments[kind].model).toBe(DEFAULT_PI_MODEL.id);
      }
    });

    it("each shipped default prompt resolves to a registered prompt name", () => {
      const assignments = loadAssignments(undefined);

      // Every prompt should match a registered prompt name
      const registeredPrompts = Object.values(DEFAULT_PROMPT_NAMES);
      for (const kind of FORM_KINDS) {
        const assignment = assignments[kind];
        expect(registeredPrompts).toContain(assignment.prompt);
        expect(assignment.prompt).toBe(DEFAULT_PROMPT_NAMES[kind]);
      }
    });
  });

  describe("TC-5.5: User override takes effect on next session start", () => {
    it("applies provider/model/prompt override for a single kind", () => {
      const config = {
        smoothed_prompt: {
          provider: "anthropic",
          model: "claude-3-opus",
          prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt,
        },
      };

      const assignments = loadAssignments(config);

      expect(assignments.smoothed_prompt.provider).toBe("anthropic");
      expect(assignments.smoothed_prompt.model).toBe("claude-3-opus");
      expect(assignments.smoothed_prompt.prompt).toBe(DEFAULT_PROMPT_NAMES.smoothed_prompt);

      // Other kinds retain defaults
      expect(assignments.tool_call_summary.provider).toBe(DEFAULT_PI_MODEL.provider);
      expect(assignments.tool_call_summary.model).toBe(DEFAULT_PI_MODEL.id);
    });

    it("applies partial override (provider only, keeps model/prompt from default)", () => {
      const config = {
        tool_call_summary: {
          provider: "openai",
          // model and prompt omitted - should throw incomplete
        },
      };

      // Partial overrides are not allowed - must specify all fields
      expect(() => loadAssignments(config)).toThrow(AssignmentValidationError);
      try {
        loadAssignments(config);
      } catch (e) {
        expect(e).toBeInstanceOf(AssignmentValidationError);
        if (e instanceof AssignmentValidationError) {
          expect(e.kind).toBe("tool_call_summary");
          expect(e.problem).toBe("incomplete");
        }
      }
    });

    it("applies multiple overrides in a single config", () => {
      const config = {
        smoothed_prompt: { provider: "anthropic", model: "claude-3-opus", prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt },
        tool_call_summary: { provider: "openai", model: "gpt-4o", prompt: DEFAULT_PROMPT_NAMES.tool_call_summary },
        turn_rendering: { provider: "google", model: "gemini-pro", prompt: DEFAULT_PROMPT_NAMES.turn_rendering },
      };

      const assignments = loadAssignments(config);

      expect(assignments.smoothed_prompt.provider).toBe("anthropic");
      expect(assignments.tool_call_summary.provider).toBe("openai");
      expect(assignments.turn_rendering.provider).toBe("google");
    });

    it("takes effect with no code change - config change only", () => {
      // First load with defaults
      const firstAssignments = loadAssignments(undefined);
      expect(firstAssignments.smoothed_prompt.provider).toBe(DEFAULT_PI_MODEL.provider);

      // Simulate user updating config
      const updatedConfig = {
        smoothed_prompt: {
          provider: "anthropic",
          model: "claude-3-opus",
          prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt,
        },
      };

      // Next session start uses updated config with no code change
      const secondAssignments = loadAssignments(updatedConfig);
      expect(secondAssignments.smoothed_prompt.provider).toBe("anthropic");
    });
  });

  describe("TC-5.6: Fails loud on incomplete/unknown/placeholder assignments", () => {
    describe("incomplete assignment - missing required field", () => {
      it("throws when provider is omitted", () => {
        const config = {
          smoothed_prompt: {
            // provider missing
            model: "claude-3-opus",
            prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt,
          },
        };

        expect(() => loadAssignments(config)).toThrow(AssignmentValidationError);
        try {
          loadAssignments(config);
        } catch (e) {
          expect(e).toBeInstanceOf(AssignmentValidationError);
          if (e instanceof AssignmentValidationError) {
            expect(e.kind).toBe("smoothed_prompt");
            expect(e.problem).toBe("incomplete");
          }
        }
      });

      it("throws when model is omitted", () => {
        const config = {
          tool_call_summary: {
            provider: "openai",
            // model missing
            prompt: DEFAULT_PROMPT_NAMES.tool_call_summary,
          },
        };

        expect(() => loadAssignments(config)).toThrow(AssignmentValidationError);
        try {
          loadAssignments(config);
        } catch (e) {
          expect(e).toBeInstanceOf(AssignmentValidationError);
          if (e instanceof AssignmentValidationError) {
            expect(e.kind).toBe("tool_call_summary");
            expect(e.problem).toBe("incomplete");
          }
        }
      });

      it("throws when prompt is omitted", () => {
        const config = {
          turn_rendering: {
            provider: "google",
            model: "gemini-pro",
            // prompt missing
          },
        };

        expect(() => loadAssignments(config)).toThrow(AssignmentValidationError);
        try {
          loadAssignments(config);
        } catch (e) {
          expect(e).toBeInstanceOf(AssignmentValidationError);
          if (e instanceof AssignmentValidationError) {
            expect(e.kind).toBe("turn_rendering");
            expect(e.problem).toBe("incomplete");
          }
        }
      });

      it("throws when partial override creates assignment with placeholder from base", () => {
        // Override provider only, but default has "unconfigured" model which is a placeholder
        // The merge should complete, but validation rejects the placeholder (AC-5.6)
        const config = {
          smoothed_prompt: {
            provider: "anthropic",
            // model and prompt missing - but base has "unconfigured" model (placeholder)
          },
        };

        // Should throw because partial override is incomplete (missing fields)
        expect(() => loadAssignments(config)).toThrow(AssignmentValidationError);
        try {
          loadAssignments(config);
        } catch (e) {
          expect(e).toBeInstanceOf(AssignmentValidationError);
          if (e instanceof AssignmentValidationError) {
            expect(e.kind).toBe("smoothed_prompt");
            expect(e.problem).toBe("incomplete");
          }
        }
      });
    });

    describe("unknown prompt - not registered in LHC prompt registry", () => {
      it("throws when prompt name is not in DEFAULT_PROMPT_NAMES", () => {
        const config = {
          smoothed_prompt: {
            provider: "anthropic",
            model: "claude-3-opus",
            prompt: "some-unknown-prompt-name",
          },
        };

        expect(() => loadAssignments(config)).toThrow(AssignmentValidationError);
        try {
          loadAssignments(config);
        } catch (e) {
          expect(e).toBeInstanceOf(AssignmentValidationError);
          if (e instanceof AssignmentValidationError) {
            expect(e.kind).toBe("smoothed_prompt");
            expect(e.problem).toBe("unknown_prompt");
          }
        }
      });

      it("throws for multiple unknown prompts across different kinds", () => {
        const config = {
          smoothed_prompt: {
            provider: "anthropic",
            model: "claude-3-opus",
            prompt: "unknown-1",
          },
          tool_call_summary: {
            provider: "openai",
            model: "gpt-4o",
            prompt: "unknown-2",
          },
        };

        // Should throw on the first validation failure (smoothed_prompt)
        expect(() => loadAssignments(config)).toThrow(AssignmentValidationError);
        try {
          loadAssignments(config);
        } catch (e) {
          expect(e).toBeInstanceOf(AssignmentValidationError);
          if (e instanceof AssignmentValidationError) {
            expect(e.problem).toBe("unknown_prompt");
          }
        }
      });
    });

    describe("placeholder values - fails loud to mask misconfiguration", () => {
      it("throws when provider contains placeholder pattern", () => {
        const config = {
          smoothed_prompt: {
            provider: "your-provider",
            model: "claude-3-opus",
            prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt,
          },
        };

        expect(() => loadAssignments(config)).toThrow(AssignmentValidationError);
        try {
          loadAssignments(config);
        } catch (e) {
          expect(e).toBeInstanceOf(AssignmentValidationError);
          if (e instanceof AssignmentValidationError) {
            expect(e.kind).toBe("smoothed_prompt");
            expect(e.problem).toBe("placeholder");
          }
        }
      });

      it("throws when model contains placeholder pattern", () => {
        const config = {
          tool_call_summary: {
            provider: "openai",
            model: "your-model",
            prompt: DEFAULT_PROMPT_NAMES.tool_call_summary,
          },
        };

        expect(() => loadAssignments(config)).toThrow(AssignmentValidationError);
        try {
          loadAssignments(config);
        } catch (e) {
          expect(e).toBeInstanceOf(AssignmentValidationError);
          if (e instanceof AssignmentValidationError) {
            expect(e.kind).toBe("tool_call_summary");
            expect(e.problem).toBe("placeholder");
          }
        }
      });

      it("throws for 'unconfigured' placeholder", () => {
        const config = {
          turn_rendering: {
            provider: "google",
            model: "unconfigured",
            prompt: DEFAULT_PROMPT_NAMES.turn_rendering,
          },
        };

        expect(() => loadAssignments(config)).toThrow(AssignmentValidationError);
        try {
          loadAssignments(config);
        } catch (e) {
          expect(e).toBeInstanceOf(AssignmentValidationError);
          if (e instanceof AssignmentValidationError) {
            expect(e.kind).toBe("turn_rendering");
            expect(e.problem).toBe("placeholder");
          }
        }
      });

      it("throws for 'placeholder' literal", () => {
        const config = {
          lower_band_projection: {
            provider: "placeholder",
            model: "some-model",
            prompt: DEFAULT_PROMPT_NAMES.lower_band_projection,
          },
        };

        expect(() => loadAssignments(config)).toThrow(AssignmentValidationError);
      });

      it("throws for 'example' placeholder pattern", () => {
        const config = {
          chunk_summary_detailed: {
            provider: "example-provider",
            model: "example-model-123",
            prompt: DEFAULT_PROMPT_NAMES.chunk_summary_detailed,
          },
        };

        expect(() => loadAssignments(config)).toThrow(AssignmentValidationError);
      });
    });

    describe("no silent fallback - never masks misconfiguration", () => {
      it("rejects unknown assignment keys loudly", () => {
        const badConfig = {
          made_up_kind: {
            provider: "openai",
            model: "gpt-4o",
            prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt,
          },
        };

        expect(() => loadAssignments(badConfig)).toThrow(/Unknown assignment key 'made_up_kind'/);
      });

      it("does not silently substitute defaults for incomplete user config", () => {
        // User provided config but it's incomplete - should throw, not use defaults
        const incompleteConfig = {
          smoothed_prompt: {
            provider: "anthropic",
            // model missing
            prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt,
          },
        };

        expect(() => loadAssignments(incompleteConfig)).toThrow(AssignmentValidationError);
      });

      it("does not silently skip unknown prompt - throws instead", () => {
        const badConfig = {
          smoothed_prompt: {
            provider: "anthropic",
            model: "claude-3-opus",
            prompt: "typo-prompt-name",
          },
        };

        expect(() => loadAssignments(badConfig)).toThrow(AssignmentValidationError);
      });
    });
  });

  describe("config edge cases", () => {
    it("handles null config by using defaults", () => {
      const assignments = loadAssignments(null);
      expect(assignments).toBeDefined();
      expect(FORM_KINDS.every((kind) => kind in assignments)).toBe(true);
    });

    it("handles empty object config by using defaults", () => {
      const assignments = loadAssignments({});
      expect(assignments).toBeDefined();
      expect(FORM_KINDS.every((kind) => kind in assignments)).toBe(true);
    });

    it("handles non-object config by using defaults", () => {
      const assignments = loadAssignments("string-config");
      expect(assignments).toBeDefined();
      expect(FORM_KINDS.every((kind) => kind in assignments)).toBe(true);
    });

    it("rejects array config loudly instead of treating indexes as assignment kinds", () => {
      expect(() => loadAssignments([1, 2, 3])).toThrow(/Unknown assignment key '0'/);
    });
  });
});
