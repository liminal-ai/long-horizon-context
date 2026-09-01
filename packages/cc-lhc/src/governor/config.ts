/**
 * Context policy load/merge/validate.
 * Precedence: builtin < user (XDG) < project (.cc-lhc.json) < session.
 *
 * The built-in layer is chosen by the active context class (200k or 1M), which
 * is derived from the effective model's observed window — never from
 * configuration. Explicit user/project/session values keep their precedence
 * over the built-ins of whichever class is active.
 *
 * Configuration can be wrong; it can never disarm the product. An unknown
 * field, a malformed value, an unreadable file, or an incoherent pair of
 * bounds falls back to the active class's built-in default for the fields
 * involved and records a notice naming the field and its source. There is no
 * field that turns Smart Compact off.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { PRODUCT_PRESET_IDS } from "./band-allocation.js";
import type {
  ConfigFallback,
  ContextClass,
  ContextPolicy,
  ContextPolicyPartial,
  ContextWindowResolution,
  PolicyFieldKey,
  PolicyFieldSource,
  PolicyFieldSources,
  ResolvedContextPolicy,
} from "./types.js";

/** The exact observed window values that select a built-in class (D8). */
export const CONTEXT_WINDOW_TOKENS: Readonly<Record<ContextClass, number>> = {
  "200k": 200_000,
  "1M": 1_000_000,
};

/** Built-in policy per context class (D1). The class is never configured. */
export const BUILTIN_CONTEXT_POLICIES: Readonly<Record<ContextClass, ContextPolicy>> = {
  "200k": {
    lowerBoundTokens: 70_000,
    upperBoundTokens: 140_000,
    profile: "default",
    pruneEnabled: false,
    pruneThresholdTokens: null,
    pruneTargetTokens: null,
    minRunwayTokens: 40_000,
  },
  "1M": {
    lowerBoundTokens: 180_000,
    upperBoundTokens: 360_000,
    profile: "default",
    pruneEnabled: false,
    pruneThresholdTokens: null,
    pruneTargetTokens: null,
    minRunwayTokens: 50_000,
  },
};

/** The class every session starts on and falls back to until a window is observed. */
export const CONSERVATIVE_CONTEXT_CLASS: ContextClass = "200k";

/** Built-in defaults of the conservative class — the policy before any window is known. */
export const BUILTIN_CONTEXT_POLICY: ContextPolicy = BUILTIN_CONTEXT_POLICIES[CONSERVATIVE_CONTEXT_CLASS];

export function builtinContextPolicy(contextClass: ContextClass): ContextPolicy {
  return BUILTIN_CONTEXT_POLICIES[contextClass];
}

/** The resolution every session starts with: nothing observed, conservative class. */
export const CONTEXT_WINDOW_NOT_YET_OBSERVED: ContextWindowResolution = {
  contextClass: CONSERVATIVE_CONTEXT_CLASS,
  source: "not_yet_observed",
  observedWindowTokens: null,
  modelId: null,
  detail: "context window not observed yet; conservative 200k policy applies",
  unresolvedAdvisory: true,
};

/** Detection could not be installed for this launch; the reason is operator-facing. */
export function contextWindowDetectionUnavailable(reason: string): ContextWindowResolution {
  return {
    contextClass: CONSERVATIVE_CONTEXT_CLASS,
    source: "detection_unavailable",
    observedWindowTokens: null,
    modelId: null,
    detail: `context window detection unavailable (${reason}); conservative 200k policy applies`,
    unresolvedAdvisory: true,
  };
}

/**
 * Exact class resolution from one observed `context_window_size` (D8): only
 * 200000 and 1000000 select a class. Any other value keeps the conservative
 * class and is reported; a value below 200000 also raises the unresolved
 * advisory because the route is outside both supported windows.
 */
export function resolveContextWindow(observedWindowTokens: number, modelId: string | null): ContextWindowResolution {
  for (const contextClass of Object.keys(CONTEXT_WINDOW_TOKENS) as ContextClass[]) {
    if (CONTEXT_WINDOW_TOKENS[contextClass] === observedWindowTokens) {
      return {
        contextClass,
        source: "observed",
        observedWindowTokens,
        modelId,
        detail: null,
        unresolvedAdvisory: false,
      };
    }
  }
  const below = observedWindowTokens < CONTEXT_WINDOW_TOKENS["200k"];
  return {
    contextClass: CONSERVATIVE_CONTEXT_CLASS,
    source: "unsupported_value",
    observedWindowTokens,
    modelId,
    detail: below
      ? `observed context window ${observedWindowTokens} is below the supported 200k class; conservative 200k policy applies`
      : `observed context window ${observedWindowTokens} is not a supported class (200000 or 1000000); conservative 200k policy applies`,
    unresolvedAdvisory: below,
  };
}

/** The operator-facing sentence every fallback surface repeats verbatim. */
export const CONFIG_FALLBACK_NOTICE =
  "Invalid compact configuration. Default configuration used. Please fix or update the configuration.";

/** Accepted user/CLI `profile` values — product preset IDs, not core names. */
export const CANONICAL_LHC_PROFILES = PRODUCT_PRESET_IDS;

const POLICY_FIELD_KEYS = Object.keys(BUILTIN_CONTEXT_POLICY) as PolicyFieldKey[];

/** The complete field set; anything else in a layer is unknown and dropped. */
export const CONTEXT_POLICY_FIELD_KEYS: readonly PolicyFieldKey[] = POLICY_FIELD_KEYS;

const KNOWN_KEYS = new Set<string>(POLICY_FIELD_KEYS);

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (typeof xdg === "string" && xdg !== "") {
    return join(resolve(xdg), "cc-lhc", "config.json");
  }
  return join(homedir(), ".config", "cc-lhc", "config.json");
}

export function projectConfigPath(cwd: string = process.cwd()): string {
  return join(resolve(cwd), ".cc-lhc.json");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface ParsedPolicyPartial {
  value: ContextPolicyPartial;
  /** Fields dropped as unknown or malformed; each already carries its origin. */
  fallbacks: ConfigFallback[];
}

/**
 * Parse a partial policy object field by field. Unknown keys and wrong types
 * are dropped with a notice rather than discarding the whole layer; bounds
 * coherence is settled later against the merged policy.
 */
export function parseContextPolicyPartial(raw: unknown, origin: string): ParsedPolicyPartial {
  const fallbacks: ConfigFallback[] = [];
  if (!isPlainObject(raw)) {
    fallbacks.push({ origin, field: null, detail: "expected a JSON object; whole layer ignored" });
    return { value: {}, fallbacks };
  }

  const out: ContextPolicyPartial = {};
  const drop = (field: PolicyFieldKey | null, detail: string): void => {
    fallbacks.push({ origin, field, detail });
  };

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) drop(null, `unknown field "${key}" ignored`);
  }

  const takeBool = (key: "pruneEnabled"): void => {
    if (!Object.hasOwn(raw, key)) return;
    const v = raw[key];
    if (typeof v !== "boolean") {
      drop(key, `${key} must be a boolean`);
      return;
    }
    out[key] = v;
  };

  const takePosInt = (key: "lowerBoundTokens" | "upperBoundTokens" | "minRunwayTokens"): void => {
    if (!Object.hasOwn(raw, key)) return;
    const v = raw[key];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
      drop(key, `${key} must be a positive safe integer`);
      return;
    }
    out[key] = v;
  };

  const takeNullablePosInt = (key: "pruneThresholdTokens" | "pruneTargetTokens"): void => {
    if (!Object.hasOwn(raw, key)) return;
    const v = raw[key];
    if (v === null) {
      out[key] = null;
      return;
    }
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
      drop(key, `${key} must be a positive safe integer or null`);
      return;
    }
    out[key] = v;
  };

  takeBool("pruneEnabled");
  takePosInt("lowerBoundTokens");
  takePosInt("upperBoundTokens");
  takePosInt("minRunwayTokens");
  takeNullablePosInt("pruneThresholdTokens");
  takeNullablePosInt("pruneTargetTokens");

  if (Object.hasOwn(raw, "profile")) {
    const v = raw.profile;
    if (typeof v !== "string" || !(CANONICAL_LHC_PROFILES as readonly string[]).includes(v)) {
      drop("profile", `profile must be one of ${PRODUCT_PRESET_IDS.join(", ")}`);
    } else {
      out.profile = v;
    }
  }

  return { value: out, fallbacks };
}

export function readJsonFile(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    if (!existsSync(path)) return { ok: true, value: undefined };
    const text = readFileSync(path, "utf8");
    if (text.trim() === "") return { ok: false, error: "empty file" };
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function emptySources(): PolicyFieldSources {
  const sources = {} as PolicyFieldSources;
  for (const k of POLICY_FIELD_KEYS) sources[k] = "builtin";
  return sources;
}

/** Which configuration layer supplied each non-builtin field, by label. */
type FieldOrigins = Partial<Record<PolicyFieldKey, string>>;

function applyPartial(
  base: ContextPolicy,
  sources: PolicyFieldSources,
  origins: FieldOrigins,
  partial: ContextPolicyPartial,
  source: PolicyFieldSource,
  origin: string,
): ContextPolicy {
  let next: ContextPolicy = base;
  for (const key of POLICY_FIELD_KEYS) {
    const value = partial[key];
    if (value === undefined) continue;
    next = { ...next, [key]: value };
    sources[key] = source;
    origins[key] = origin;
  }
  return next;
}

/** One coherence rule over the merged policy, plus the fields it constrains. */
interface CoherenceRule {
  fields: readonly PolicyFieldKey[];
  check: (policy: ContextPolicy) => string | null;
}

const COHERENCE_RULES: readonly CoherenceRule[] = [
  {
    fields: ["lowerBoundTokens", "upperBoundTokens"],
    check: (p) =>
      p.upperBoundTokens <= p.lowerBoundTokens
        ? `upperBoundTokens (${p.upperBoundTokens}) must be greater than lowerBoundTokens (${p.lowerBoundTokens})`
        : null,
  },
  {
    fields: ["lowerBoundTokens", "upperBoundTokens", "minRunwayTokens"],
    check: (p) => {
      const runway = p.upperBoundTokens - p.lowerBoundTokens;
      return runway < p.minRunwayTokens
        ? `upper−lower runway (${runway}) is below minRunwayTokens (${p.minRunwayTokens})`
        : null;
    },
  },
  {
    fields: ["pruneEnabled", "pruneThresholdTokens", "pruneTargetTokens"],
    check: (p) => {
      if (!p.pruneEnabled) return null;
      if (p.pruneThresholdTokens === null || p.pruneTargetTokens === null) {
        return "pruneEnabled requires pruneThresholdTokens and pruneTargetTokens";
      }
      return p.pruneTargetTokens >= p.pruneThresholdTokens
        ? `pruneTargetTokens (${p.pruneTargetTokens}) must be less than pruneThresholdTokens (${p.pruneThresholdTokens})`
        : null;
    },
  },
];

/** Per-field shape check, shared by config parsing and panel edits. */
function fieldErrors(policy: ContextPolicy): string[] {
  const errors: string[] = [];
  const posInt = (key: "lowerBoundTokens" | "upperBoundTokens" | "minRunwayTokens"): void => {
    const v = policy[key];
    if (!Number.isSafeInteger(v) || v <= 0) errors.push(`${key} must be a positive safe integer`);
  };
  posInt("lowerBoundTokens");
  posInt("upperBoundTokens");
  posInt("minRunwayTokens");
  for (const key of ["pruneThresholdTokens", "pruneTargetTokens"] as const) {
    const v = policy[key];
    if (v !== null && (!Number.isSafeInteger(v) || v <= 0)) {
      errors.push(`${key} must be a positive safe integer or null`);
    }
  }
  if (!(CANONICAL_LHC_PROFILES as readonly string[]).includes(policy.profile)) {
    errors.push(`profile must be one of ${PRODUCT_PRESET_IDS.join(", ")}`);
  }
  return errors;
}

/**
 * Report shape and coherence problems in a candidate policy. Used by the
 * panel's atomic edit, which rejects the edit and keeps the running policy.
 */
export function validateContextPolicy(policy: ContextPolicy): string[] {
  const errors = fieldErrors(policy);
  if (errors.length > 0) return errors;
  for (const rule of COHERENCE_RULES) {
    const error = rule.check(policy);
    if (error !== null) errors.push(error);
  }
  return errors;
}

/**
 * Settle coherence by reverting configured fields to the active class's
 * built-in defaults.
 *
 * Only fields a user actually set are reverted, so the offending value loses
 * and the built-in wins. Reverting strictly reduces the configured set, so
 * this terminates at (at worst) the wholly-coherent built-in policy.
 */
function settleCoherence(
  policy: ContextPolicy,
  sources: PolicyFieldSources,
  origins: FieldOrigins,
  fallbacks: ConfigFallback[],
  builtin: ContextPolicy,
): ContextPolicy {
  let current = policy;
  for (let pass = 0; pass <= POLICY_FIELD_KEYS.length; pass += 1) {
    let reverted = false;
    for (const rule of COHERENCE_RULES) {
      const error = rule.check(current);
      if (error === null) continue;
      const configured = rule.fields.filter((field) => sources[field] !== "builtin");
      if (configured.length === 0) continue;
      let next: ContextPolicy = current;
      for (const field of configured) {
        next = { ...next, [field]: builtin[field] };
        fallbacks.push({
          origin: origins[field] ?? `${sources[field]} config`,
          field,
          detail: `${error}; ${field} reset to the built-in default for the active context window`,
        });
        sources[field] = "builtin";
        delete origins[field];
      }
      current = next;
      reverted = true;
    }
    if (!reverted) return current;
  }
  return current;
}

export interface LoadContextPolicyOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Explicit session overrides (not persisted). */
  sessionOverrides?: ContextPolicyPartial | unknown;
  /** Test seam: substitute user config path. */
  userConfigPath?: string;
  /** Test seam: substitute project config path. */
  projectConfigPath?: string;
  /** Test seam: read JSON by path. */
  readJson?: (path: string) => { ok: true; value: unknown } | { ok: false; error: string };
  /**
   * The observed context window this load resolves against. Defaults to the
   * not-yet-observed conservative resolution; `applyContextWindow` re-resolves
   * the same layers when a window is observed later.
   */
  contextWindow?: ContextWindowResolution;
}

/**
 * Load and merge policy with explicit precedence. Always returns a usable
 * policy; anything that could not be honoured is listed in `fallbacks`.
 */
export function loadContextPolicy(options: LoadContextPolicyOptions = {}): ResolvedContextPolicy {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const readJson = options.readJson ?? readJsonFile;
  const userPath = options.userConfigPath ?? userConfigPath(env);
  const projectPath = options.projectConfigPath ?? projectConfigPath(cwd);

  const contextWindow = options.contextWindow ?? CONTEXT_WINDOW_NOT_YET_OBSERVED;
  const builtin = builtinContextPolicy(contextWindow.contextClass);
  const fallbacks: ConfigFallback[] = [];
  const sources = emptySources();
  const origins: FieldOrigins = {};
  let policy: ContextPolicy = { ...builtin };

  const mergeLayer = (raw: unknown, origin: string, source: PolicyFieldSource): void => {
    const parsed = parseContextPolicyPartial(raw, origin);
    fallbacks.push(...parsed.fallbacks);
    policy = applyPartial(policy, sources, origins, parsed.value, source, origin);
  };

  const mergeFile = (path: string, label: string, source: PolicyFieldSource): void => {
    const raw = readJson(path);
    if (!raw.ok) {
      fallbacks.push({ origin: `${label} ${path}`, field: null, detail: `${raw.error}; whole layer ignored` });
      return;
    }
    if (raw.value === undefined) return;
    mergeLayer(raw.value, `${label} ${path}`, source);
  };

  mergeFile(userPath, "user config", "user");
  mergeFile(projectPath, "project config", "project");
  if (options.sessionOverrides !== undefined) {
    mergeLayer(options.sessionOverrides, "session overrides", "session");
  }

  policy = settleCoherence(policy, sources, origins, fallbacks, builtin);

  return { policy, sources, fallbacks, contextWindow };
}

/**
 * Re-resolve an already-loaded policy against a newly observed context window
 * (AC-1.4). Only model-derived values move: every field still on its built-in
 * source takes the new class's built-in; explicit user/project/session values
 * keep their value and precedence. Coherence is settled again so an explicit
 * value that no longer fits the new built-ins falls back per field, named.
 */
export function applyContextWindow(
  resolved: ResolvedContextPolicy,
  contextWindow: ContextWindowResolution,
): ResolvedContextPolicy {
  const builtin = builtinContextPolicy(contextWindow.contextClass);
  const sources: PolicyFieldSources = { ...resolved.sources };
  const origins: FieldOrigins = {};
  let policy: ContextPolicy = { ...resolved.policy };
  for (const key of POLICY_FIELD_KEYS) {
    if (sources[key] === "builtin") policy = { ...policy, [key]: builtin[key] };
    else origins[key] = `${sources[key]} config`;
  }
  // Coherence fallbacks recorded at load are re-derived here from the same
  // explicit values; earlier notices about unknown/malformed fields survive.
  const fallbacks = resolved.fallbacks.filter((f) => f.field === null || !f.detail.includes("reset to the built-in"));
  const carried: ConfigFallback[] = [...fallbacks];
  policy = settleCoherence(policy, sources, origins, carried, builtin);
  return { policy, sources, fallbacks: carried, contextWindow };
}

/** Compact source summary for observe records. */
export function policySourcesSummary(sources: PolicyFieldSources): string {
  const parts: string[] = [];
  for (const key of ["lowerBoundTokens", "upperBoundTokens", "profile"] as const) {
    parts.push(`${key}=${sources[key]}`);
  }
  return parts.join(",");
}

/**
 * Operator-facing lines for every fallback, headed by the required notice.
 * Empty when configuration was fully usable. The same lines go to startup
 * output, the wrapper log, the control panel, and the compact message.
 */
export function formatConfigFallbackNotice(fallbacks: readonly ConfigFallback[]): string[] {
  if (fallbacks.length === 0) return [];
  return [CONFIG_FALLBACK_NOTICE, ...fallbacks.map((f) => `  ${f.origin}: ${f.detail}`)];
}
