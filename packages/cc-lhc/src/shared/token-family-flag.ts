/**
 * `--token-family` for commands that run without a live wrapper session.
 * Same rule as core's CLI: required, no default, unknown slug is a usage error.
 */

import { FAMILIES_CATALOG } from "lhc";

export function knownTokenFamilySlugs(): string {
  return Object.keys(FAMILIES_CATALOG.families).sort().join(", ");
}

export function parseTokenFamilyFlag(
  slug: string | undefined,
): { ok: true; family: string } | { ok: false; reason: string } {
  const known = knownTokenFamilySlugs();
  if (slug === undefined || slug === "") {
    return { ok: false, reason: `--token-family is required (known: ${known})` };
  }
  if (!Object.hasOwn(FAMILIES_CATALOG.families, slug)) {
    return { ok: false, reason: `--token-family ${slug} is not a known family (known: ${known})` };
  }
  return { ok: true, family: slug };
}
