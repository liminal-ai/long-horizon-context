// Deterministic truncation for tool-result floors. Pure: no inference, DB,
// clock, or config, so identical source text always yields identical output.
export const FALLBACK_TRUNCATION_LIMIT = 200;

export function truncateForFallback(text: string): string {
  if (text.length <= FALLBACK_TRUNCATION_LIMIT) return text;
  const dropped = text.length - FALLBACK_TRUNCATION_LIMIT;
  return `${text.slice(0, FALLBACK_TRUNCATION_LIMIT)}… [truncated ${dropped} chars]`;
}
