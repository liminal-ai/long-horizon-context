"""Ported from packages/lhc/src/thread-view/internal/profiles.ts. Phase 1 skeleton.

Profile config resolution and validation: built-in profiles, user profiles
merged over them by name, and the budget rules. Band shares sum to 100, lower
bound is positive, visibility max is greater than target. Pure functions, no
IO. Config mistakes are programmer errors at SDK construction and throw
naming the violation; nothing here returns OpResults.

CONSTANT DATA: built-in profiles, visibility defaults, and compact threshold
are real verbatim values — not skeletons.
"""

from __future__ import annotations

from typing import Literal, NoReturn

from ...shared_tech.view import (
    PartialVisibilityBudgets,
    ResolvedViewConfig,
    SdkViewConfig,
    ViewProfile,
    ViewProfileOverride,
    ViewProfilePercentages,
    VisibilityBudgets,
)

# Built-in profiles: defaults and knobs, not architecture.
BUILT_IN_PROFILES: tuple[ViewProfile, ...] = (
    ViewProfile(
        name="continuation",
        lower_bound=120000,
        percentages=ViewProfilePercentages(full=30, smooth=30, detailed=20, brief=20),
    ),
    ViewProfile(
        name="conversation",
        lower_bound=120000,
        percentages=ViewProfilePercentages(full=12, smooth=48, detailed=20, brief=20),
    ),
    ViewProfile(
        name="coding",
        lower_bound=120000,
        percentages=ViewProfilePercentages(full=25, smooth=35, detailed=20, brief=20),
    ),
)

DEFAULT_VISIBILITY = VisibilityBudgets(
    max_tokens=64000,
    target_tokens=32000,
)

DEFAULT_COMPACT_THRESHOLD = 160000

_BAND_KEYS: tuple[Literal["full", "smooth", "detailed", "brief"], ...] = (
    "full",
    "smooth",
    "detailed",
    "brief",
)

# Constant DATA: raw config object keys (verbatim TS). Phase 2 maps these to
# VisibilityBudgets snake_case attributes.
_BUDGET_KEYS: tuple[Literal["maxTokens", "targetTokens"], ...] = (
    "maxTokens",
    "targetTokens",
)

_FAIL_PREFIX = "initLhc config: view: "


def _fail(detail: str) -> NoReturn:
    raise NotImplementedError


# The violated constraint, named, or null when the profile is sound: one
# rule set shared by both rejection surfaces — SDK construction (throws,
# below) and compact invocation (caller-error result).
def profile_violation(profile: ViewProfile) -> str | None:
    raise NotImplementedError


# A complete, merged profile validates whole: positive lower bound, finite
# non-negative shares, shares summing to exactly 100. Errors name the
# violated constraint and the profile.
def validate_profile(profile: ViewProfile) -> None:
    raise NotImplementedError


def _is_complete_override(entry: ViewProfileOverride) -> bool:
    raise NotImplementedError


# Merge one configured entry: field-wise over the built-in it names, or — for
# a name no built-in carries — the entry must be complete, since there is
# nothing to merge over.
def _merge_profile(entry: ViewProfileOverride, base: ViewProfile | None) -> ViewProfile:
    raise NotImplementedError


def _resolve_visibility(partial: PartialVisibilityBudgets | None) -> VisibilityBudgets:
    raise NotImplementedError


# The one resolution path: built-ins, user profiles merged by name, every
# resolved profile validated, visibility and threshold defaulted and checked.
# Called from initLhc so validation runs through real construction.
def resolve_view_config(config: SdkViewConfig | None = None) -> ResolvedViewConfig:
    raise NotImplementedError
