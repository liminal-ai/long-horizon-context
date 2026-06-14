import { describe, expect, it } from "vitest";
import {
  CORPUS_LOADERS,
  loadAllCorpora,
  makeTruncatedCorpus,
  validateCorpus,
} from "./corpus.js";

// Architecture-risk test (tech design §Architecture-Risk Tests — Fixture
// Validity): Story 0 owns no AC, but every later capture/verification test
// depends on these corpora being trustworthy, so the loader's output is checked
// here rather than assumed.
describe("corpus fixtures", () => {
  it("yields valid MessageEventInput shapes and lifecycle-coherent sequences for every named corpus", () => {
    const corpora = loadAllCorpora();
    expect(corpora).toHaveLength(Object.keys(CORPUS_LOADERS).length);

    for (const corpus of corpora) {
      const result = validateCorpus(corpus);
      // name the defects if any — a bare boolean would hide which corpus broke
      expect(result.problems).toEqual([]);
      expect(result.valid).toBe(true);
      // a real recorded sequence, not an empty stub, and a closed turn
      expect(corpus.expected.length).toBeGreaterThan(0);
      expect(corpus.expected.at(-1)?.eventKind).toBe("turn_end");
    }
  });

  it("produces an intentionally malformed shape from the named invalid builder that the validator rejects", () => {
    const result = validateCorpus(makeTruncatedCorpus());
    expect(result.valid).toBe(false);
    // the validator inspects shape: it names the specific defects, not a generic fail
    expect(result.problems.some((p) => p.includes("empty text"))).toBe(true);
    expect(result.problems.some((p) => p.includes("no preceding tool_call"))).toBe(true);
    expect(result.problems.some((p) => p.includes("does not close with turn_end"))).toBe(true);
  });
});
