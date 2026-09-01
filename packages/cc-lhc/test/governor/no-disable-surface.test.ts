/**
 * TC-1.5d: Smart Compact has no disable surface or disabled state.
 *
 * Load-bearing census over the real source, help, README, and docs, plus the
 * live parser, config schema, panel registry, and governor. Reintroducing any
 * off switch — a policy field, a launch flag, a panel command, a decision
 * kind, a receipt outcome, or prose that offers one — fails here.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseWrapperArgv } from "../../src/cli-args.js";
import {
  BUILTIN_CONTEXT_POLICIES,
  CONTEXT_POLICY_FIELD_KEYS,
  loadContextPolicy,
  parseContextPolicyPartial,
} from "../../src/governor/config.js";
import { decideGovernor } from "../../src/governor/decide.js";
import type { GovernorInput } from "../../src/governor/types.js";
import { CC_LHC_HELP } from "../../src/help.js";
import { PANEL_COMMANDS, parsePanelCommand } from "../../src/wrapper/panel-commands.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".ts") || path.endsWith(".md")) out.push(path);
  }
  return out;
}

/** Every spelling an off switch has had or could plausibly take. */
const FORBIDDEN = [
  /\bautoCompact\b/,
  /\bpolicy_disabled\b/,
  /--lhc-auto-compact/,
  /\/lhc-auto\b/,
  /\/auto\b/,
  /\bautoCompactIntent\b/,
  /\bsmartCompactEnabled\b/,
  /\bcompactEnabled\b/,
];

describe("no Smart Compact disable surface (TC-1.5d)", () => {
  it("source, help, README, and onboarding docs carry no off switch", () => {
    const files = [
      ...walk(join(PACKAGE_ROOT, "src")),
      join(PACKAGE_ROOT, "README.md"),
      join(REPO_ROOT, "docs", "onboard", "05-host-cc-lhc.md"),
    ];
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN) {
        const line = text.split("\n").findIndex((l) => pattern.test(l));
        if (line >= 0) hits.push(`${file.replace(`${REPO_ROOT}/`, "")}:${line + 1} ${pattern}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("the CLI parser has no flag that reads as off", () => {
    for (const flag of ["--lhc-auto-compact=off", "--lhc-auto-compact=on", "--lhc-smart-compact=off"]) {
      expect(parseWrapperArgv([flag]).ok, flag).toBe(false);
    }
    const parsed = parseWrapperArgv(["--lhc-upper-bound-tokens=140000"]);
    expect(parsed.ok && Object.keys(parsed.parsed.contextPolicyOverrides)).toEqual(["upperBoundTokens"]);
  });

  it("the configuration schema has no disable field and drops any it is handed", () => {
    expect(CONTEXT_POLICY_FIELD_KEYS).not.toContain("autoCompact");
    for (const cls of ["200k", "1M"] as const) {
      expect(Object.keys(BUILTIN_CONTEXT_POLICIES[cls])).not.toContain("autoCompact");
    }
    const parsed = parseContextPolicyPartial({ autoCompact: false, smartCompact: "off", enabled: false }, "probe");
    expect(parsed.value).toEqual({});
    expect(parsed.fallbacks).toHaveLength(3);
    const loaded = loadContextPolicy({
      userConfigPath: "/nonexistent/user.json",
      projectConfigPath: "/nonexistent/project.json",
      sessionOverrides: { autoCompact: false } as never,
    });
    expect(loaded.policy).toEqual(BUILTIN_CONTEXT_POLICIES["200k"]);
  });

  it("the Control Panel registry has no on/off command", () => {
    expect(PANEL_COMMANDS.map((c) => c.name)).not.toContain("/auto");
    for (const line of ["/auto off", "/auto on", "/smart-compact off"]) {
      const parsed = parsePanelCommand(line);
      expect(parsed.kind, line).toBe("unknown");
    }
    for (const command of PANEL_COMMANDS) {
      expect(`${command.usage} ${command.summary} ${command.helpSummary}`).not.toMatch(/\b(on\|off|turn .* off)\b/);
    }
  });

  it("the governor has no disabled decision, whatever is smuggled onto the policy", () => {
    const input: GovernorInput = {
      policy: { ...BUILTIN_CONTEXT_POLICIES["200k"], autoCompact: false, enabled: false } as never,
      turnOpen: false,
      providerContext: { inputTokens: 150_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, total: 150_000 },
      providerContextFreshness: "current_sampling",
      postMeasurementEstimate: { tokens: 0, source: "lhc_token_estimate", domain: "source_labelled_estimate" },
      operationInFlight: false,
      contextLimitRejected: false,
    };
    const d = decideGovernor(input);
    expect(d.kind).toBe("would_compact");
    expect(d.wouldMutate).toBe(true);
  });

  it("help advertises the invariant and no off switch", () => {
    expect(CC_LHC_HELP).toContain("cannot be turned off");
    for (const pattern of FORBIDDEN) expect(CC_LHC_HELP).not.toMatch(pattern);
  });
});
