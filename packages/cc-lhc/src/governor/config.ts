/**
 * Context policy load/merge/validate.
 * Precedence: builtin < user (XDG) < project (.cc-lhc.json) < session.
 * Unknown fields and invalid bounds fail loudly — no silent normalize.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type {
  ContextPolicy,
  ContextPolicyPartial,
  NativeCompactMode,
  PolicyFieldKey,
  PolicyFieldSource,
  PolicyFieldSources,
  ResolvedContextPolicy,
} from "./types.js";

/** Steward built-in defaults for the work-ready path (Slice 4: auto on). */
export const BUILTIN_CONTEXT_POLICY: ContextPolicy = {
  autoCompact: true,
  lowerBoundTokens: 180_000,
  upperBoundTokens: 360_000,
  profile: "continuation",
  nativeCompactMode: "emergency_backstop",
  nativeBackstopTokens: 1_000_000,
  pruneEnabled: false,
  pruneThresholdTokens: null,
  pruneTargetTokens: null,
  observeOnly: false,
  retryGrowthTokens: 10_000,
  minRunwayTokens: 50_000,
};

/** Canonical SDK profile names — no second percentage ontology. */
export const CANONICAL_LHC_PROFILES = ["continuation", "conversation", "coding"] as const;

const KNOWN_KEYS = new Set<string>([
  "autoCompact",
  "lowerBoundTokens",
  "upperBoundTokens",
  "profile",
  "nativeCompactMode",
  "nativeBackstopTokens",
  "pruneEnabled",
  "pruneThresholdTokens",
  "pruneTargetTokens",
  "retryGrowthTokens",
  "minRunwayTokens",
  "observeOnly",
]);

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

/**
 * Parse a partial policy object. Rejects unknown keys and wrong types.
 * Does not validate bounds (that is validateContextPolicy).
 */
export function parseContextPolicyPartial(
  raw: unknown,
  label: string,
  options: { allowObserveOnly?: boolean } = {},
): { ok: true; value: ContextPolicyPartial } | { ok: false; errors: string[] } {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [`${label}: expected a JSON object`] };
  }
  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      errors.push(`${label}: unknown field "${key}"`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const out: ContextPolicyPartial = {};

  const takeBool = (key: "autoCompact" | "pruneEnabled" | "observeOnly"): void => {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) return;
    const v = raw[key];
    if (typeof v !== "boolean") {
      errors.push(`${label}: ${key} must be a boolean`);
      return;
    }
    if (key === "observeOnly") {
      // Session-only: a persisted observe-only would silently disable automatic
      // policy forever; the escape hatch must be explicit per launch.
      if (options.allowObserveOnly !== true) {
        errors.push(`${label}: observeOnly cannot be set in persisted config`);
        return;
      }
      out.observeOnly = v;
      return;
    }
    if (key === "autoCompact") out.autoCompact = v;
    if (key === "pruneEnabled") out.pruneEnabled = v;
  };

  const takePosInt = (
    key:
      | "lowerBoundTokens"
      | "upperBoundTokens"
      | "nativeBackstopTokens"
      | "retryGrowthTokens"
      | "minRunwayTokens"
      | "pruneThresholdTokens"
      | "pruneTargetTokens",
  ): void => {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) return;
    const v = raw[key];
    if (v === null && (key === "pruneThresholdTokens" || key === "pruneTargetTokens")) {
      if (key === "pruneThresholdTokens") out.pruneThresholdTokens = null;
      else out.pruneTargetTokens = null;
      return;
    }
    if (typeof v !== "number" || !Number.isFinite(v) || !Number.isSafeInteger(v) || v <= 0) {
      errors.push(`${label}: ${key} must be a positive safe integer`);
      return;
    }
    (out as Record<string, number | null>)[key] = v;
  };

  takeBool("autoCompact");
  takeBool("pruneEnabled");
  takeBool("observeOnly");
  takePosInt("lowerBoundTokens");
  takePosInt("upperBoundTokens");
  takePosInt("nativeBackstopTokens");
  takePosInt("retryGrowthTokens");
  takePosInt("minRunwayTokens");
  takePosInt("pruneThresholdTokens");
  takePosInt("pruneTargetTokens");

  if (Object.prototype.hasOwnProperty.call(raw, "profile")) {
    const v = raw.profile;
    if (typeof v !== "string" || v === "") {
      errors.push(`${label}: profile must be a non-empty string`);
    } else {
      out.profile = v;
    }
  }

  if (Object.prototype.hasOwnProperty.call(raw, "nativeCompactMode")) {
    const v = raw.nativeCompactMode;
    if (v !== "emergency_backstop") {
      errors.push(`${label}: nativeCompactMode must be "emergency_backstop"`);
    } else {
      out.nativeCompactMode = v as NativeCompactMode;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}

export function readJsonFile(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    if (!existsSync(path)) return { ok: true, value: undefined };
    const text = readFileSync(path, "utf8");
    if (text.trim() === "") return { ok: false, error: `${path}: empty file` };
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: `${path}: ${msg}` };
  }
}

function emptySources(): PolicyFieldSources {
  const keys = Object.keys(BUILTIN_CONTEXT_POLICY) as PolicyFieldKey[];
  const sources = {} as PolicyFieldSources;
  for (const k of keys) sources[k] = "builtin";
  return sources;
}

function applyPartial(
  base: ContextPolicy,
  sources: PolicyFieldSources,
  partial: ContextPolicyPartial,
  source: PolicyFieldSource,
): ContextPolicy {
  const next: ContextPolicy = { ...base };
  const assign = <K extends PolicyFieldKey>(key: K, value: ContextPolicy[K]): void => {
    next[key] = value;
    sources[key] = source;
  };

  if (partial.autoCompact !== undefined) assign("autoCompact", partial.autoCompact);
  if (partial.lowerBoundTokens !== undefined) assign("lowerBoundTokens", partial.lowerBoundTokens);
  if (partial.upperBoundTokens !== undefined) assign("upperBoundTokens", partial.upperBoundTokens);
  if (partial.profile !== undefined) assign("profile", partial.profile);
  if (partial.nativeCompactMode !== undefined) assign("nativeCompactMode", partial.nativeCompactMode);
  if (partial.nativeBackstopTokens !== undefined) {
    assign("nativeBackstopTokens", partial.nativeBackstopTokens);
  }
  if (partial.pruneEnabled !== undefined) assign("pruneEnabled", partial.pruneEnabled);
  if (partial.pruneThresholdTokens !== undefined) {
    assign("pruneThresholdTokens", partial.pruneThresholdTokens);
  }
  if (partial.pruneTargetTokens !== undefined) assign("pruneTargetTokens", partial.pruneTargetTokens);
  if (partial.retryGrowthTokens !== undefined) assign("retryGrowthTokens", partial.retryGrowthTokens);
  if (partial.minRunwayTokens !== undefined) assign("minRunwayTokens", partial.minRunwayTokens);
  if (partial.observeOnly !== undefined) assign("observeOnly", partial.observeOnly);
  return next;
}

/**
 * Validate bounds and coherence. Returns errors; does not normalize.
 */
export function validateContextPolicy(policy: ContextPolicy): string[] {
  const errors: string[] = [];
  if (!Number.isSafeInteger(policy.lowerBoundTokens) || policy.lowerBoundTokens <= 0) {
    errors.push("lowerBoundTokens must be a positive safe integer");
  }
  if (!Number.isSafeInteger(policy.upperBoundTokens) || policy.upperBoundTokens <= 0) {
    errors.push("upperBoundTokens must be a positive safe integer");
  }
  if (
    Number.isSafeInteger(policy.lowerBoundTokens) &&
    Number.isSafeInteger(policy.upperBoundTokens) &&
    policy.upperBoundTokens <= policy.lowerBoundTokens
  ) {
    errors.push(
      `upperBoundTokens (${policy.upperBoundTokens}) must be greater than lowerBoundTokens (${policy.lowerBoundTokens})`,
    );
  }
  if (
    Number.isSafeInteger(policy.lowerBoundTokens) &&
    Number.isSafeInteger(policy.upperBoundTokens) &&
    policy.upperBoundTokens > policy.lowerBoundTokens
  ) {
    const runway = policy.upperBoundTokens - policy.lowerBoundTokens;
    if (runway < policy.minRunwayTokens) {
      errors.push(
        `upper−lower runway (${runway}) is below minRunwayTokens (${policy.minRunwayTokens})`,
      );
    }
  }
  if (!Number.isSafeInteger(policy.nativeBackstopTokens) || policy.nativeBackstopTokens <= 0) {
    errors.push("nativeBackstopTokens must be a positive safe integer");
  } else if (
    Number.isSafeInteger(policy.upperBoundTokens) &&
    policy.nativeBackstopTokens <= policy.upperBoundTokens
  ) {
    errors.push(
      `nativeBackstopTokens (${policy.nativeBackstopTokens}) must be greater than upperBoundTokens (${policy.upperBoundTokens})`,
    );
  }
  if (!(CANONICAL_LHC_PROFILES as readonly string[]).includes(policy.profile)) {
    errors.push(
      `profile "${policy.profile}" is not a canonical LHC profile (${CANONICAL_LHC_PROFILES.join(", ")})`,
    );
  }
  if (policy.nativeCompactMode !== "emergency_backstop") {
    errors.push('nativeCompactMode must be "emergency_backstop"');
  }
  if (typeof policy.observeOnly !== "boolean") {
    errors.push("observeOnly must be a boolean");
  }
  if (!Number.isSafeInteger(policy.retryGrowthTokens) || policy.retryGrowthTokens <= 0) {
    errors.push("retryGrowthTokens must be a positive safe integer");
  }
  if (!Number.isSafeInteger(policy.minRunwayTokens) || policy.minRunwayTokens <= 0) {
    errors.push("minRunwayTokens must be a positive safe integer");
  }
  if (policy.pruneEnabled) {
    if (policy.pruneThresholdTokens === null || policy.pruneTargetTokens === null) {
      errors.push("pruneEnabled requires pruneThresholdTokens and pruneTargetTokens");
    } else if (policy.pruneTargetTokens >= policy.pruneThresholdTokens) {
      errors.push(
        `pruneTargetTokens (${policy.pruneTargetTokens}) must be less than pruneThresholdTokens (${policy.pruneThresholdTokens})`,
      );
    }
  }
  return errors;
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
 * Load and merge policy with explicit precedence.
 * Always returns a ResolvedContextPolicy; armed=false when errors prevent arming.
 */
export function loadContextPolicy(options: LoadContextPolicyOptions = {}): ResolvedContextPolicy {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const readJson = options.readJson ?? readJsonFile;
  const userPath = options.userConfigPath ?? userConfigPath(env);
  const projectPath = options.projectConfigPath ?? projectConfigPath(cwd);

  const errors: string[] = [];
  const sources = emptySources();
  let policy: ContextPolicy = { ...BUILTIN_CONTEXT_POLICY };

  const userRaw = readJson(userPath);
  if (!userRaw.ok) {
    errors.push(userRaw.error);
  } else if (userRaw.value !== undefined) {
    const parsed = parseContextPolicyPartial(userRaw.value, `user config ${userPath}`);
    if (!parsed.ok) errors.push(...parsed.errors);
    else policy = applyPartial(policy, sources, parsed.value, "user");
  }

  const projectRaw = readJson(projectPath);
  if (!projectRaw.ok) {
    errors.push(projectRaw.error);
  } else if (projectRaw.value !== undefined) {
    const parsed = parseContextPolicyPartial(projectRaw.value, `project config ${projectPath}`);
    if (!parsed.ok) errors.push(...parsed.errors);
    else policy = applyPartial(policy, sources, parsed.value, "project");
  }

  if (options.sessionOverrides !== undefined) {
    const parsed = parseContextPolicyPartial(options.sessionOverrides, "session overrides", {
      allowObserveOnly: true,
    });
    if (!parsed.ok) errors.push(...parsed.errors);
    else policy = applyPartial(policy, sources, parsed.value, "session");
  }

  const validationErrors = validateContextPolicy(policy);
  errors.push(...validationErrors);

  const armed = errors.length === 0;
  return {
    policy,
    sources,
    armed,
    errors,
  };
}

/** Compact source summary for observe records. */
export function policySourcesSummary(sources: PolicyFieldSources): string {
  const parts: string[] = [];
  for (const key of [
    "autoCompact",
    "lowerBoundTokens",
    "upperBoundTokens",
    "profile",
    "nativeBackstopTokens",
  ] as const) {
    parts.push(`${key}=${sources[key]}`);
  }
  return parts.join(",");
}
