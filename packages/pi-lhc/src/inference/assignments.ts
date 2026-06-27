// Load inference assignment config; fail loud on missing, unknown, or
// placeholder values.
//
// Assignments provide provider, model, and prompt for LHC's inference-backed
// derivation kinds. LHC validates assignment shape at construction
// (non-empty provider/model, prompt-name registered).
// This layer adds operator config loading on top, with user overrides that
// take effect on the next session start (no code change).
//
// Shipped defaults are defined in model-call.ts (defaultAssignments). This
// module merges operator config over those defaults and validates the result.

import type { ModelAssignment } from "lhc";
import { DEFAULT_PROMPT_NAMES } from "lhc";
import { ASSIGNMENT_KINDS, type AssignmentKind, defaultAssignments } from "./model-call.js";

/** Operator config shape for derivation assignments.
 *
 *  Each key is optional; missing kinds use the shipped default. Values override
 *  provider, model, or prompt for that kind. An assignment is incomplete if it
 *  omits any of provider, model, or prompt and fails loud at load.
 *
 *  Example:
 *  {
 *    smoothed_prompt: { provider: "openai", model: "gpt-4o", prompt: "custom-smoothing" },
 *    tool_result_summary: { provider: "anthropic", model: "claude-3-opus", prompt: DEFAULT_PROMPT_NAMES.tool_result_summary }
 *  }
 */
export interface AssignmentConfig {
  [key: string]: Partial<ModelAssignment> | undefined;
}

/** Error thrown when an assignment is incomplete or references an unknown prompt.
 *  Carries the kind and specific validation problem for actionable reporting. */
export class AssignmentValidationError extends Error {
  readonly kind: AssignmentKind;
  readonly problem: "incomplete" | "unknown_prompt" | "placeholder";

  constructor(kind: AssignmentKind, problem: "incomplete" | "unknown_prompt" | "placeholder") {
    let message: string;
    switch (problem) {
      case "incomplete":
        message = `Assignment for '${kind}' is incomplete: must specify provider, model, and prompt`;
        break;
      case "unknown_prompt":
        message = `Assignment for '${kind}' references an unknown prompt: prompt must be registered in LHC's prompt registry`;
        break;
      case "placeholder":
        message = `Assignment for '${kind}' contains placeholder values: provider and model must be concrete identifiers`;
        break;
    }
    super(message);
    this.name = "AssignmentValidationError";
    this.kind = kind;
    this.problem = problem;
  }
}

/** Check if an assignment is complete (has provider, model, and prompt). */
function isComplete(assignment: Partial<ModelAssignment>): assignment is ModelAssignment {
  return assignment.provider !== undefined && assignment.model !== undefined && assignment.prompt !== undefined;
}

/** Check if an assignment contains placeholder values that would mask misconfiguration. */
function hasPlaceholder(assignment: ModelAssignment): boolean {
  const placeholderPatterns = [
    "unconfigured",
    "placeholder",
    "example",
    "your-",
    "your_provider",
    "your-model",
    "your_model",
  ];
  const providerLower = assignment.provider.toLowerCase();
  const modelLower = assignment.model.toLowerCase();

  return placeholderPatterns.some((pattern) => providerLower.includes(pattern) || modelLower.includes(pattern));
}

/** Check if a prompt name is registered in LHC's prompt registry. */
function isPromptRegistered(promptName: string): boolean {
  return Object.values(DEFAULT_PROMPT_NAMES).includes(promptName);
}

/** Validate a single assignment and throw if it fails shape checks. */
function validateAssignment(kind: AssignmentKind, assignment: Partial<ModelAssignment>): ModelAssignment {
  if (!isComplete(assignment)) {
    throw new AssignmentValidationError(kind, "incomplete");
  }

  // Check for placeholder values; placeholders fail loud.
  if (hasPlaceholder(assignment)) {
    throw new AssignmentValidationError(kind, "placeholder");
  }

  // Check that the prompt names a registered prompt.
  if (!isPromptRegistered(assignment.prompt)) {
    throw new AssignmentValidationError(kind, "unknown_prompt");
  }

  return assignment;
}

/** Load + shape-validate inference derivation assignments from operator config.
 *
 *  - Merges operator config over shipped defaults.
 *  - Falls back to defaults when config is missing or undefined.
 *  - User overrides take effect on next thread start with no code change.
 *  - Incomplete assignments fail loud at initialization.
 *  - Unknown prompts fail loud at initialization.
 *  - Placeholder values fail loud at initialization.
 *
 *  This function throws `AssignmentValidationError` on any validation failure;
 *  the caller (typically the session_start hook) catches and surfaces the error
 *  as an actionable diagnostic. It never returns an incomplete or placeholder map
 *  that would mask a misconfiguration. */
export function loadAssignments(config: unknown): Record<AssignmentKind, ModelAssignment> {
  const baseAssignments = defaultAssignments();
  const mergedAssignments: Partial<Record<AssignmentKind, ModelAssignment>> = {};

  for (const kind of ASSIGNMENT_KINDS) {
    mergedAssignments[kind] = validateAssignment(kind, baseAssignments[kind] ?? {});
  }

  // If config is missing/null/undefined, use defaults as-is
  if (config === null || config === undefined || typeof config !== "object") {
    return mergedAssignments as Record<AssignmentKind, ModelAssignment>;
  }

  const configObj = config as Partial<Record<AssignmentKind, Partial<ModelAssignment>>>;

  // Check for unknown assignment keys (SV-002: fail loud on extra keys)
  const configKeys = Object.keys(configObj) as Array<string>;
  for (const key of configKeys) {
    if (key !== "" && !ASSIGNMENT_KINDS.includes(key as AssignmentKind)) {
      throw new Error(`Unknown assignment key '${key}': must be one of ${ASSIGNMENT_KINDS.join(", ")}`);
    }
  }

  // Merge operator config over defaults for kinds that are specified
  for (const kind of ASSIGNMENT_KINDS) {
    const override = configObj[kind];
    if (override !== undefined) {
      mergedAssignments[kind] = validateAssignment(kind, { ...mergedAssignments[kind]!, ...override });
    }
  }

  return mergedAssignments as Record<AssignmentKind, ModelAssignment>;
}
