/**
 * LIM-117: TC-4.2a, TC-4.3a-b. Pure presentation/selection; no Control Panel redesign.
 */
import { describe, expect, it } from "vitest";

import {
  applySessionAllocation,
  compactConstruction,
  mutationCoreProfile,
} from "../../src/governor/band-allocation.js";
import { BUILTIN_CONTEXT_POLICY, loadContextPolicy } from "../../src/governor/config.js";
import {
  allocationDisplayRows,
  allocationSelectorChoices,
  allocationSelectorRows,
  homeAllocationPhrase,
  presentAllocation,
} from "../../src/wrapper/preset-presentation.js";

describe("TC-4.2a select from Control Panel", () => {
  it("panel selection immediately updates presentation and next mutation construction", () => {
    const launch = loadContextPolicy();
    expect(launch.policy.profile).toBe("default");
    expect(presentAllocation("default").label).toBe("Default");

    const afterSelect = applySessionAllocation(launch, "historical");
    expect(afterSelect.policy.profile).toBe("historical");
    expect(afterSelect.sources.profile).toBe("session");
    const shown = presentAllocation("historical");
    expect(shown.label).toBe("Historical");
    expect([shown.low, shown.medium, shown.high, shown.full]).toEqual([30, 20, 30, 20]);
    expect(allocationDisplayRows("historical").join("\n")).toContain("Historical");
    expect(allocationDisplayRows("historical").join("\n")).toContain("30%");

    expect(compactConstruction(afterSelect.policy)).toEqual({
      profile: "cc-lhc-historical",
      params: { lowerBound: BUILTIN_CONTEXT_POLICY.lowerBoundTokens },
    });
    expect(mutationCoreProfile(afterSelect.policy.profile)).toBe("cc-lhc-historical");
    expect(afterSelect.sources.profile).toBe("session");
  });
});

describe("TC-4.3a show active allocation", () => {
  it("Home/selector show active label, description, and four percentages without total row", () => {
    const rows = allocationDisplayRows("historical");
    expect(rows).toContain("Historical");
    expect(rows).toContain("broader low-fidelity history");
    expect(rows).toEqual(expect.arrayContaining(["Low 30%", "Medium 20%", "High 30%", "Full 20%"]));
    expect(rows.join("\n")).not.toMatch(/\b100\s*%/);
    expect(rows.join("\n").toLowerCase()).not.toContain("total");
  });
});

describe("Home allocation phrase", () => {
  it("is the tail clause of the selector description, short enough for one Home row", () => {
    for (const id of ["default", "balanced", "historical"] as const) {
      const shown = presentAllocation(id);
      // Derived from the selector copy, so the two cannot drift apart.
      expect(shown.description.endsWith(shown.homeDescription), id).toBe(true);
      expect(shown.homeDescription, id).not.toBe("");
      expect(shown.homeDescription, id).not.toContain(" — ");
      // Home has ~44 columns for label + phrase at the normal card width.
      expect(`${shown.label} — ${shown.homeDescription}`.length, id).toBeLessThanOrEqual(44);
    }
    expect(presentAllocation("default").homeDescription).toBe("emphasizes recent history");
    expect(presentAllocation("balanced").homeDescription).toBe("equal fidelity distribution");
    expect(presentAllocation("historical").homeDescription).toBe("broader low-fidelity history");
    expect(homeAllocationPhrase("a — b — c")).toBe("c");
    expect(homeAllocationPhrase("plain")).toBe("plain");
  });

  it("leaves the selector copy and the display rows unreduced", () => {
    expect(presentAllocation("default").description).toBe("initial selection — emphasizes recent history");
    expect(allocationDisplayRows("default")).toContain("initial selection — emphasizes recent history");
    expect(allocationSelectorChoices("default")[0]?.description).toBe("initial selection — emphasizes recent history");
  });
});

describe("TC-4.3b no custom editor", () => {
  it("selector exposes only Default/Balanced/Historical and no edit/create controls", () => {
    const choices = allocationSelectorChoices("balanced");
    expect(choices.map((choice) => choice.id)).toEqual(["default", "balanced", "historical"]);
    expect(choices.map((choice) => choice.label)).toEqual(["Default", "Balanced", "Historical"]);
    expect(choices.filter((choice) => choice.selected).map((choice) => choice.id)).toEqual(["balanced"]);
    const text = allocationSelectorRows("balanced").join("\n").toLowerCase();
    expect(text).not.toContain("edit");
    expect(text).not.toContain("create");
    expect(text).not.toContain("custom");
    expect(text).not.toContain("add preset");
  });
});
