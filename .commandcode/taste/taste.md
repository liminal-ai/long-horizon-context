# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# architecture
See [architecture/taste.md](architecture/taste.md)
# code-style
See [code-style/taste.md](code-style/taste.md)
# testing
- Do not add public surface operations or exported internals whose only purpose is to enable testing; test through the real entry points with realistic scenarios instead of exposing state-transition helpers or test-only seams. Confidence: 0.75
- Do not write tests that verify a removed or renamed thing stayed removed or renamed (regression tombstones). Confidence: 0.80
- When a later story replaces prior-story stubs, placeholders, or deferred behavior with real implementations, update the prior-story tests that asserted the stub state, re-record immutability verification hashes, and list each changed file explicitly in the implementation result. Confidence: 0.70
- When designed randomness in production (e.g., random IDs) prevents literal byte-identical test comparisons in replay/determinism tests, normalize only the random field(s) with a guard asserting the values actually differ, requiring every other byte exact — do not add test-only injection seams to production code. Confidence: 0.75

# workflow
See [workflow/taste.md](workflow/taste.md)
# documentation
- Keep onboarding documentation accessible: use clear, simple language that defines key terms without needing further definitions; avoid dense jargon-packed explanations where the explanation itself requires glossary lookups. Confidence: 0.75
- Target each documentation level at a specific audience and purpose: level 1 (onboarding) is glossary and core lexicon, level 2 (domain design) is slightly deeper domain breakdown with ownership and capability mapping; do not mix levels or skip between them in the same doc. Confidence: 0.70
- When choosing terminology for documentation and code, prefer terms that are immediately understandable without requiring glossary lookups; avoid overly generic two-word combinations ("view profile", "tool run") that sound like placeholders rather than deliberate concept names. Confidence: 0.65

# vocabulary
- Do not use "projection" wording in code, comments, or documentation for this project; use current derivation/compression vocabulary instead. Confidence: 0.70
- Few-shot examples inside prompt templates are historical training material, not normative vocabulary definitions; do not "fix" them to match current terminology unless output quality is measurably degraded. Confidence: 0.70
