import {
  allocationById,
  BAND_ALLOCATIONS,
  type BandAllocation,
  type BandAllocationId,
} from "../governor/band-allocation.js";

export interface PresetPresentation {
  id: BandAllocationId;
  label: BandAllocation["label"];
  description: string;
  homeDescription: string;
  low: number;
  medium: number;
  high: number;
  full: number;
}

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
