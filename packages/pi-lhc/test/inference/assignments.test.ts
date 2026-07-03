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
      expect(assignments.detailed_turn_compression.provider).toBe(DEFAULT_PI_MODEL.provider);
      expect(assignments.detailed_turn_compression.model).toBe(DEFAULT_PI_MODEL.id);
    });

    it("applies partial override (provider only, keeps model/prompt/thinking from default)", () => {
      const config = {
        detailed_turn_compression: {
          provider: "openai",
        },
      };

      const assignments = loadAssignments(config);

      expect(assignments.detailed_turn_compression.provider).toBe("openai");
      expect(assignments.detailed_turn_compression.model).toBe(DEFAULT_PI_MODEL.id);
      expect(assignments.detailed_turn_compression.prompt).toBe(DEFAULT_PROMPT_NAMES.detailed_turn_compression);
      expect(assignments.detailed_turn_compression.thinking).toBe("none");
    });

    it("preserves thinking none when override omits thinking", () => {
      const config = {
        smoothed_prompt: {
          provider: "anthropic",
          model: "claude-3-opus",
          prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt,
        },
      };

      const assignments = loadAssignments(config);

      expect(assignments.smoothed_prompt.thinking).toBe("none");
    });

    it("applies multiple overrides in a single config", () => {
      const config = {
        smoothed_prompt: {
          provider: "anthropic",
          model: "claude-3-opus",
          prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt,
        },
        detailed_turn_compression: {
          provider: "openai",
          model: "gpt-4o",
          prompt: DEFAULT_PROMPT_NAMES.detailed_turn_compression,
        },
        chunk_summary_brief: {
          provider: "google",
          model: "gemini-pro",
          prompt: DEFAULT_PROMPT_NAMES.chunk_summary_brief,
        },
      };

      const assignments = loadAssignments(config);

      expect(assignments.smoothed_prompt.provider).toBe("anthropic");
      expect(assignments.detailed_turn_compression.provider).toBe("openai");
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
    describe("partial override merges missing fields from defaults", () => {
      it("fills provider from default when override omits it", () => {
        const config = {
          smoothed_prompt: {
            model: "claude-3-opus",
            prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt,
          },
        };

        const assignments = loadAssignments(config);

        expect(assignments.smoothed_prompt.provider).toBe(DEFAULT_PI_MODEL.provider);
        expect(assignments.smoothed_prompt.model).toBe("claude-3-opus");
        expect(assignments.smoothed_prompt.thinking).toBe("none");
      });

      it("fills model from default when override omits it", () => {
        const config = {
          detailed_turn_compression: {
            provider: "openai",
            prompt: DEFAULT_PROMPT_NAMES.detailed_turn_compression,
          },
        };

        const assignments = loadAssignments(config);

        expect(assignments.detailed_turn_compression.provider).toBe("openai");
        expect(assignments.detailed_turn_compression.model).toBe(DEFAULT_PI_MODEL.id);
        expect(assignments.detailed_turn_compression.thinking).toBe("none");
      });

      it("fills prompt from default when override omits it", () => {
        const config = {
          detailed_turn_compression: {
            provider: "google",
            model: "gemini-pro",
          },
        };

        const assignments = loadAssignments(config);

        expect(assignments.detailed_turn_compression.provider).toBe("google");
        expect(assignments.detailed_turn_compression.model).toBe("gemini-pro");
        expect(assignments.detailed_turn_compression.prompt).toBe(DEFAULT_PROMPT_NAMES.detailed_turn_compression);
        expect(assignments.detailed_turn_compression.thinking).toBe("none");
      });

      it("merges partial override over defaults when base assignment is complete", () => {
        const config = {
          smoothed_prompt: {
            provider: "anthropic",
          },
        };

        const assignments = loadAssignments(config);

        expect(assignments.smoothed_prompt.provider).toBe("anthropic");
        expect(assignments.smoothed_prompt.model).toBe(DEFAULT_PI_MODEL.id);
        expect(assignments.smoothed_prompt.prompt).toBe(DEFAULT_PROMPT_NAMES.smoothed_prompt);
        expect(assignments.smoothed_prompt.thinking).toBe("none");
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
          detailed_turn_compression: {
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
          detailed_turn_compression: {
            provider: "openai",
            model: "your-model",
            prompt: DEFAULT_PROMPT_NAMES.detailed_turn_compression,
          },
        };

        expect(() => loadAssignments(config)).toThrow(AssignmentValidationError);
        try {
          loadAssignments(config);
        } catch (e) {
          expect(e).toBeInstanceOf(AssignmentValidationError);
          if (e instanceof AssignmentValidationError) {
            expect(e.kind).toBe("detailed_turn_compression");
            expect(e.problem).toBe("placeholder");
          }
        }
      });

      it("throws for 'unconfigured' placeholder", () => {
        const config = {
          detailed_turn_compression: {
            provider: "google",
            model: "unconfigured",
            prompt: DEFAULT_PROMPT_NAMES.detailed_turn_compression,
          },
        };

        expect(() => loadAssignments(config)).toThrow(AssignmentValidationError);
        try {
          loadAssignments(config);
        } catch (e) {
          expect(e).toBeInstanceOf(AssignmentValidationError);
          if (e instanceof AssignmentValidationError) {
            expect(e.kind).toBe("detailed_turn_compression");
            expect(e.problem).toBe("placeholder");
          }
        }
      });

      it("throws for 'placeholder' literal", () => {
        const config = {
          detailed_turn_compression: {
            provider: "placeholder",
            model: "some-model",
            prompt: DEFAULT_PROMPT_NAMES.detailed_turn_compression,
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

      it("still fails loud when merged override references an unknown prompt", () => {
        const incompleteConfig = {
          smoothed_prompt: {
            provider: "anthropic",
            model: "claude-3-opus",
            prompt: "typo-prompt-name",
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
