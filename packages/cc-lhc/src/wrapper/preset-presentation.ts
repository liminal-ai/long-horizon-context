/**
 * Pure Band % presentation and selection model for Home and the allocation
 * selector. Story 3 connects this to the terminal UI; this module is the
 * Story 2 render/selection contract.
 */
import {
  type BandAllocation,
  type BandAllocationId,
  BAND_ALLOCATIONS,
  allocationById,
} from "../governor/band-allocation.js";

export interface PresetPresentation {
  id: BandAllocationId;
  label: BandAllocation["label"];
  description: string;
  /**
   * Home's one-line phrase for the same allocation, in plain language: what
   * this choice does to the context the user sees.
   */
  homeDescription: string;
  low: number;
  medium: number;
  high: number;
  full: number;
}

/**
 * Home's plain-language phrase per allocation. Home has one row for the
 * explanation, and it answers "what does this do to my context?" rather than
 * naming band mechanics; the selector keeps the fuller wording.
 */
const HOME_ALLOCATION_PHRASES: Record<BandAllocationId, string> = {
  default: "favors recent detail",
  balanced: "spreads space evenly",
  historical: "keeps more older history",
};

export function homeAllocationPhrase(id: BandAllocationId): string {
  return HOME_ALLOCATION_PHRASES[id];
}

export function presentAllocation(id: BandAllocationId): PresetPresentation {
  const allocation = allocationById(id);
  return {
    id: allocation.id,
    label: allocation.label,
    description: allocation.description,
    homeDescription: homeAllocationPhrase(allocation.id),
    low: allocation.low,
    medium: allocation.medium,
    high: allocation.high,
    full: allocation.full,
  };
}

/** Home / selector body: name, description, four percentages; no total row. */
export function allocationDisplayRows(id: BandAllocationId): string[] {
  const shown = presentAllocation(id);
  return [
    shown.label,
    shown.description,
    `Low ${shown.low}%`,
    `Medium ${shown.medium}%`,
    `High ${shown.high}%`,
    `Full ${shown.full}%`,
  ];
}

export interface AllocationChoice {
  id: BandAllocationId;
  label: BandAllocation["label"];
  description: string;
  selected: boolean;
}

/** Selector choices: exactly the three shipped presets, no edit/create controls. */
export function allocationSelectorChoices(selected: BandAllocationId): AllocationChoice[] {
  return BAND_ALLOCATIONS.map((allocation) => ({
    id: allocation.id,
    label: allocation.label,
    description: allocation.description,
    selected: allocation.id === selected,
  }));
}

export function allocationSelectorRows(selected: BandAllocationId): string[] {
  return allocationSelectorChoices(selected).flatMap((choice) => [
    `${choice.selected ? ">" : " "} ${choice.label}`,
    `    ${choice.description}`,
  ]);
}
