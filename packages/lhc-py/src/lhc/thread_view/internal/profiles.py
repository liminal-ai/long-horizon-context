"""Ported from packages/lhc/src/thread-view/internal/profiles.ts.

Profile config resolution and validation: built-in profiles, user profiles
merged over them by name, and the budget rules. Band shares sum to 100, lower
bound is positive, visibility max is greater than target. Pure functions, no
IO. Config mistakes are programmer errors at SDK construction and throw
naming the violation; nothing here returns OpResults.

CONSTANT DATA: built-in profiles, visibility defaults, and compact threshold
are real verbatim values — not skeletons.
"""

from __future__ import annotations

import math
from typing import Literal, Mapping, NoReturn

from ...shared_tech._jsstr import js_repr
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
    raise TypeError(f"{_FAIL_PREFIX}{detail}")


def _is_finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


# The violated constraint, named, or null when the profile is sound: one
# rule set shared by both rejection surfaces — SDK construction (throws,
# below) and compact invocation (caller-error result).
def profile_violation(profile: ViewProfile) -> str | None:
    if not _is_finite_number(profile.lower_bound) or profile.lower_bound <= 0:
        return (
            f'profile "{profile.name}": lowerBound must be a positive number, '
            f"got {js_repr(profile.lower_bound)}"
        )
    for key in _BAND_KEYS:
        share = getattr(profile.percentages, key)
        if not _is_finite_number(share) or share < 0:
            return (
                f'profile "{profile.name}": percentage {key} must be a '
                f"non-negative number, got {js_repr(share)}"
            )
    total = sum(getattr(profile.percentages, key) for key in _BAND_KEYS)
    if total != 100:
        return (
            f'profile "{profile.name}": percentages must sum to 100, '
            f"got {js_repr(total)}"
        )
    return None


# A complete, merged profile validates whole: positive lower bound, finite
# non-negative shares, shares summing to exactly 100. Errors name the
# violated constraint and the profile.
def validate_profile(profile: ViewProfile) -> None:
    violation = profile_violation(profile)
    if violation is not None:
        _fail(violation)


def _is_complete_override(entry: ViewProfileOverride) -> bool:
    if entry.lower_bound is None or entry.percentages is None:
        return False
    return all(getattr(entry.percentages, key) is not None for key in _BAND_KEYS)


# Merge one configured entry: field-wise over the built-in it names, or — for
# a name no built-in carries — the entry must be complete, since there is
# nothing to merge over.
def _merge_profile(entry: ViewProfileOverride, base: ViewProfile | None) -> ViewProfile:
    if base is None:
        if not _is_complete_override(entry):
            built_in_names = ", ".join(f'"{p.name}"' for p in BUILT_IN_PROFILES)
            _fail(
                f'profile "{entry.name}" is partial but overrides no built-in '
                f"(unknown built-in override target); built-ins are {built_in_names} "
                "— a new profile must carry lowerBound and all four percentages"
            )
        assert entry.percentages is not None
        return ViewProfile(
            name=entry.name,
            lower_bound=entry.lower_bound,  # type: ignore[arg-type]
            percentages=ViewProfilePercentages(
                full=entry.percentages.full,  # type: ignore[arg-type]
                smooth=entry.percentages.smooth,  # type: ignore[arg-type]
                detailed=entry.percentages.detailed,  # type: ignore[arg-type]
                brief=entry.percentages.brief,  # type: ignore[arg-type]
            ),
        )
    percentages = entry.percentages
    return ViewProfile(
        name=entry.name,
        lower_bound=(
            base.lower_bound if entry.lower_bound is None else entry.lower_bound
        ),
        percentages=ViewProfilePercentages(
            full=(
                base.percentages.full
                if percentages is None or percentages.full is None
                else percentages.full
            ),
            smooth=(
                base.percentages.smooth
                if percentages is None or percentages.smooth is None
                else percentages.smooth
            ),
            detailed=(
                base.percentages.detailed
                if percentages is None or percentages.detailed is None
                else percentages.detailed
            ),
            brief=(
                base.percentages.brief
                if percentages is None or percentages.brief is None
                else percentages.brief
            ),
        ),
    )


def _visibility_raw_keys(partial: PartialVisibilityBudgets | Mapping[str, object] | None) -> list[str]:
    if partial is None:
        return []
    if isinstance(partial, Mapping):
        return list(partial.keys())
    # Dataclass path: only emit keys that were conceptually "present". TS
    # Object.keys skips undefined; we treat None fields as absent.
    keys: list[str] = []
    if partial.max_tokens is not None:
        keys.append("maxTokens")
    if partial.target_tokens is not None:
        keys.append("targetTokens")
    return keys


def _resolve_visibility(partial: PartialVisibilityBudgets | None) -> VisibilityBudgets:
    # Unknown budget fields are config mistakes, not silent passengers.
    for key in _visibility_raw_keys(partial):
        if key not in _BUDGET_KEYS:
            _fail(
                f"visibility.{key} is not a budget field "
                "(budgets are maxTokens and targetTokens)"
            )
    max_tokens = (
        DEFAULT_VISIBILITY.max_tokens
        if partial is None or partial.max_tokens is None
        else partial.max_tokens
    )
    target_tokens = (
        DEFAULT_VISIBILITY.target_tokens
        if partial is None or partial.target_tokens is None
        else partial.target_tokens
    )
    visibility = VisibilityBudgets(max_tokens=max_tokens, target_tokens=target_tokens)
    for snake, camel in (
        ("max_tokens", "maxTokens"),
        ("target_tokens", "targetTokens"),
    ):
        value = getattr(visibility, snake)
        if not _is_finite_number(value) or value <= 0:
            _fail(f"visibility.{camel} must be a positive number, got {js_repr(value)}")
    # The budget ordering rule: max > target.
    if visibility.max_tokens <= visibility.target_tokens:
        _fail(
            f"visibility.maxTokens ({js_repr(visibility.max_tokens)}) must be greater than "
            f"targetTokens ({js_repr(visibility.target_tokens)})"
        )
    return visibility


# The one resolution path: built-ins, user profiles merged by name, every
# resolved profile validated, visibility and threshold defaulted and checked.
# Called from initLhc so validation runs through real construction.
def resolve_view_config(config: SdkViewConfig | None = None) -> ResolvedViewConfig:
    profiles: dict[str, ViewProfile] = {}
    for built_in in BUILT_IN_PROFILES:
        profiles[built_in.name] = built_in
    entries = [] if config is None or config.profiles is None else config.profiles
    for entry in entries:
        if not isinstance(entry.name, str) or len(entry.name) == 0:
            _fail("profile entries must carry a non-empty name")
        profiles[entry.name] = _merge_profile(entry, profiles.get(entry.name))
    for profile in profiles.values():
        validate_profile(profile)

    compact_threshold = (
        DEFAULT_COMPACT_THRESHOLD
        if config is None or config.compact_threshold is None
        else config.compact_threshold
    )
    if not _is_finite_number(compact_threshold) or compact_threshold <= 0:
        _fail(
            f"compactThreshold must be a positive number, got {js_repr(compact_threshold)}"
        )

    return ResolvedViewConfig(
        profiles=profiles,
        visibility=_resolve_visibility(
            None if config is None else config.visibility
        ),
        compact_threshold=compact_threshold,
    )
