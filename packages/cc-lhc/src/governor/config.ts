/**
 * Context policy load/merge/validate.
 * Precedence: builtin < user (XDG) < project (.cc-lhc.json) < session.
 *
 * Configuration can be wrong; it can never disarm the product. An unknown
 * field, a malformed value, an unreadable file, or an incoherent pair of
 * bounds falls back to the built-in default for the fields involved and
 * records a notice. Automatic compact stays armed either way — a typo in
 * `~/.config/cc-lhc/config.json` must not be a silent off switch for the one
 * function that keeps long sessions alive.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type {
  ConfigFallback,
  ContextPolicy,
  ContextPolicyPartial,
  PolicyFieldKey,
  PolicyFieldSource,
  PolicyFieldSources,
  ResolvedContextPolicy,
} from "./types.js";

/** Steward built-in defaults. Automatic compact is on. */
export const BUILTIN_CONTEXT_POLICY: ContextPolicy = {
  autoCompact: true,
  lowerBoundTokens: 180_000,
  upperBoundTokens: 360_000,
  profile: "continuation",
  pruneEnabled: false,
  pruneThresholdTokens: null,
  pruneTargetTokens: null,
  minRunwayTokens: 50_000,
};

/** The operator-facing sentence every fallback surface repeats verbatim. */
export const CONFIG_FALLBACK_NOTICE =
  "Invalid compact configuration. Default configuration used. Please fix or update the configuration.";

/** Canonical SDK profile names — no second percentage ontology. */
export const CANONICAL_LHC_PROFILES = ["continuation", "conversation", "coding"] as const;

const POLICY_FIELD_KEYS = Object.keys(BUILTIN_CONTEXT_POLICY) as PolicyFieldKey[];

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

  const takeBool = (key: "autoCompact" | "pruneEnabled"): void => {
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

  takeBool("autoCompact");
  takeBool("pruneEnabled");
  takePosInt("lowerBoundTokens");
  takePosInt("upperBoundTokens");
  takePosInt("minRunwayTokens");
  takeNullablePosInt("pruneThresholdTokens");
  takeNullablePosInt("pruneTargetTokens");

  if (Object.hasOwn(raw, "profile")) {
    const v = raw.profile;
    if (typeof v !== "string" || !(CANONICAL_LHC_PROFILES as readonly string[]).includes(v)) {
      drop("profile", `profile must be one of ${CANONICAL_LHC_PROFILES.join(", ")}`);
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
    errors.push(`profile "${policy.profile}" is not a canonical LHC profile (${CANONICAL_LHC_PROFILES.join(", ")})`);
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
 * Settle coherence by reverting configured fields to their built-in defaults.
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
        next = { ...next, [field]: BUILTIN_CONTEXT_POLICY[field] };
        fallbacks.push({
          origin: origins[field] ?? `${sources[field]} config`,
          field,
          detail: `${error}; ${field} reset to built-in default`,
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

  const fallbacks: ConfigFallback[] = [];
  const sources = emptySources();
  const origins: FieldOrigins = {};
  let policy: ContextPolicy = { ...BUILTIN_CONTEXT_POLICY };

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

  policy = settleCoherence(policy, sources, origins, fallbacks);

  return { policy, sources, fallbacks };
}

/** Compact source summary for observe records. */
export function policySourcesSummary(sources: PolicyFieldSources): string {
  const parts: string[] = [];
  for (const key of ["autoCompact", "lowerBoundTokens", "upperBoundTokens", "profile"] as const) {
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
