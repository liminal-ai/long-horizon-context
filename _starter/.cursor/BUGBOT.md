# Bugbot rules

You are the primary bug-finder for this repo (see .github/REVIEW_RULES.md for the other bots' lanes).

Focus:
- Logic errors, off-by-one and boundary bugs, null/undefined paths, unhandled promise rejections, missing awaits.
- Regressions: changed behavior that existing callers or tests rely on.
- Error handling that swallows failures or leaves state half-written (write then persist then rollback).
- Timer/scheduling bugs (e.g. setTimeout delays > 2^31-1 ms clamp to 1 ms), retry loops without bounds.
- Secrets, tokens, or URLs that contain credentials reaching logs or error messages.

Ignore:
- Style, naming, formatting, import order, lint-level issues (CI handles these).
- Vendored/generated paths: `.repos/**`, `third-party/**`, `vendor/**`, `**/dist/**`, `**/*.gen.ts`, `**/_generated/**`, lockfiles.

Format: one comment per distinct bug; include a concrete failing scenario. No praise, no summaries of what the PR does.
