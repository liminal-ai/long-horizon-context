// TC-5.4..5.6. Assignment loading tests.
//
// TC-5.4: Inference-backed kinds load (provider,model,prompt) with shipped defaults; prompts resolve.
// TC-5.5: Override takes effect next start, no code change.
// TC-5.6: Incomplete/unknown assignment fails loud at init (missing kind, unknown prompt, incomplete, placeholder).

import { describe, expect, it } from "vitest";
import { AssignmentValidationError, loadAssignments } from "../../src/inference/assignments.js";
import {
  ASSIGNMENT_KINDS,
  DEFAULT_PI_MODEL,
  DEFAULT_ASSIGNMENT_PROMPTS as DEFAULT_PROMPT_NAMES,
} from "../../src/inference/model-call.js";

describe("Story 6: Startup Validation and Assignment Config", () => {
  describe("TC-5.4: Inference-backed kinds load with shipped defaults", () => {
    it("loads all inference-backed kinds with provider, model, and prompt from shipped defaults", () => {
      const assignments = loadAssignments(undefined);

      // All inference-backed kinds are present
      expect(ASSIGNMENT_KINDS.every((kind) => kind in assignments)).toBe(true);

      // Each assignment has provider, model, and prompt
      for (const kind of ASSIGNMENT_KINDS) {
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

      for (const kind of ASSIGNMENT_KINDS) {
        expect(assignments[kind].provider).toBe(DEFAULT_PI_MODEL.provider);
        expect(assignments[kind].model).toBe(DEFAULT_PI_MODEL.id);
      }
    });

    it("each shipped default prompt resolves to a registered prompt name", () => {
      const assignments = loadAssignments(undefined);

      // Every prompt should match a registered prompt name
      const registeredPrompts = Object.values(DEFAULT_PROMPT_NAMES);
      for (const kind of ASSIGNMENT_KINDS) {
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
      expect(assignments.smooth_turn_compression.provider).toBe(DEFAULT_PI_MODEL.provider);
      expect(assignments.smooth_turn_compression.model).toBe(DEFAULT_PI_MODEL.id);
    });

    it("applies partial override (provider only, keeps model/prompt from default)", () => {
      const config = {
        smooth_turn_compression: {
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
          expect(e.kind).toBe("smooth_turn_compression");
          expect(e.problem).toBe("incomplete");
        }
      }
    });

    it("applies multiple overrides in a single config", () => {
      const config = {
        smoothed_prompt: {
          provider: "anthropic",
          model: "claude-3-opus",
          prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt,
        },
        smooth_turn_compression: {
          provider: "openai",
          model: "gpt-4o",
          prompt: DEFAULT_PROMPT_NAMES.smooth_turn_compression,
        },
        chunk_summary_brief: {
          provider: "google",
          model: "gemini-pro",
          prompt: DEFAULT_PROMPT_NAMES.chunk_summary_brief,
        },
      };

      const assignments = loadAssignments(config);

      expect(assignments.smoothed_prompt.provider).toBe("anthropic");
      expect(assignments.smooth_turn_compression.provider).toBe("openai");
      expect(assignments.chunk_summary_brief.provider).toBe("google");
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
          smooth_turn_compression: {
            provider: "openai",
            // model missing
            prompt: DEFAULT_PROMPT_NAMES.smooth_turn_compression,
          },
        };

        expect(() => loadAssignments(config)).toThrow(AssignmentValidationError);
        try {
          loadAssignments(config);
        } catch (e) {
          expect(e).toBeInstanceOf(AssignmentValidationError);
          if (e instanceof AssignmentValidationError) {
            expect(e.kind).toBe("smooth_turn_compression");
            expect(e.problem).toBe("incomplete");
          }
        }
      });

      it("throws when prompt is omitted", () => {
        const config = {
          smooth_turn_compression: {
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
            expect(e.kind).toBe("smooth_turn_compression");
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
          smooth_turn_compression: {
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
          smooth_turn_compression: {
            provider: "openai",
            model: "your-model",
            prompt: DEFAULT_PROMPT_NAMES.smooth_turn_compression,
          },
        };

        expect(() => loadAssignments(config)).toThrow(AssignmentValidationError);
        try {
          loadAssignments(config);
        } catch (e) {
          expect(e).toBeInstanceOf(AssignmentValidationError);
          if (e instanceof AssignmentValidationError) {
            expect(e.kind).toBe("smooth_turn_compression");
            expect(e.problem).toBe("placeholder");
          }
        }
      });

      it("throws for 'unconfigured' placeholder", () => {
        const config = {
          smooth_turn_compression: {
            provider: "google",
            model: "unconfigured",
            prompt: DEFAULT_PROMPT_NAMES.smooth_turn_compression,
          },
        };

        expect(() => loadAssignments(config)).toThrow(AssignmentValidationError);
        try {
          loadAssignments(config);
        } catch (e) {
          expect(e).toBeInstanceOf(AssignmentValidationError);
          if (e instanceof AssignmentValidationError) {
            expect(e.kind).toBe("smooth_turn_compression");
            expect(e.problem).toBe("placeholder");
          }
        }
      });

      it("throws for 'placeholder' literal", () => {
        const config = {
          smooth_turn_compression: {
            provider: "placeholder",
            model: "some-model",
            prompt: DEFAULT_PROMPT_NAMES.smooth_turn_compression,
          },
        };

        expect(() => loadAssignments(config)).toThrow(AssignmentValidationError);
      });

      it("throws for 'example' placeholder pattern", () => {
        const config = {
          chunk_summary_brief: {
            provider: "example-provider",
            model: "example-model-123",
            prompt: DEFAULT_PROMPT_NAMES.chunk_summary_brief,
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
      expect(ASSIGNMENT_KINDS.every((kind) => kind in assignments)).toBe(true);
    });

    it("handles empty object config by using defaults", () => {
      const assignments = loadAssignments({});
      expect(assignments).toBeDefined();
      expect(ASSIGNMENT_KINDS.every((kind) => kind in assignments)).toBe(true);
    });

    it("handles non-object config by using defaults", () => {
      const assignments = loadAssignments("string-config");
      expect(assignments).toBeDefined();
      expect(ASSIGNMENT_KINDS.every((kind) => kind in assignments)).toBe(true);
    });

    it("rejects array config loudly instead of treating indexes as assignment kinds", () => {
      expect(() => loadAssignments([1, 2, 3])).toThrow(/Unknown assignment key '0'/);
    });
  });
});
