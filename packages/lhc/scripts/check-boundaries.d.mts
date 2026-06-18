// Type declarations for the boundary checker, so tests can import its
// rule-classification function (check-boundaries.mjs is plain ESM with no
// emitted types).
export function checkSource(filePath: string, source: string): string[];
