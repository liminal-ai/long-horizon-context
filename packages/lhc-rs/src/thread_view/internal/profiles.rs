//! Ported from packages/lhc/src/thread-view/internal/profiles.ts.
//!
//! Profile config resolution and validation: built-in profiles, user profiles
//! merged over them by name, and the budget rules. Band shares sum to 100, lower
//! bound is positive, visibility max is greater than target. Pure functions, no
//! IO. Config mistakes are programmer errors at SDK construction and throw
//! naming the violation; nothing here returns OpResults.
//!
//! CONSTANT DATA: built-in profiles, visibility defaults, compact threshold,
//! BAND_KEYS, and BUDGET_KEYS are real verbatim values — not skeletons.
//! Resolution/validation function bodies remain `todo!("phase 2")`.

use std::sync::LazyLock;

use indexmap::IndexMap;

use crate::shared_tech::view::{
    PartialVisibilityBudgets, ResolvedViewConfig, SdkViewConfig, ViewProfile, ViewProfileOverride,
    ViewProfilePercentages, VisibilityBudgets,
};

/// Built-in profiles: defaults and knobs, not architecture.
pub static BUILT_IN_PROFILES: LazyLock<Vec<ViewProfile>> = LazyLock::new(|| {
    vec![
        ViewProfile {
            name: "continuation".to_string(),
            lower_bound: 120000,
            percentages: ViewProfilePercentages {
                full: 30,
                smooth: 30,
                detailed: 20,
                brief: 20,
            },
        },
        ViewProfile {
            name: "conversation".to_string(),
            lower_bound: 120000,
            percentages: ViewProfilePercentages {
                full: 12,
                smooth: 48,
                detailed: 20,
                brief: 20,
            },
        },
        ViewProfile {
            name: "coding".to_string(),
            lower_bound: 120000,
            percentages: ViewProfilePercentages {
                full: 25,
                smooth: 35,
                detailed: 20,
                brief: 20,
            },
        },
    ]
});

pub const DEFAULT_VISIBILITY: VisibilityBudgets = VisibilityBudgets {
    max_tokens: 64000.0,
    target_tokens: 32000.0,
};

pub const DEFAULT_COMPACT_THRESHOLD: f64 = 160000.0;

/// TS `BAND_KEYS` — profile percentage field names (verbatim).
pub(crate) const BAND_KEYS: [&str; 4] = ["full", "smooth", "detailed", "brief"];

/// TS `BUDGET_KEYS` — raw config object keys (verbatim TS camelCase).
/// Phase 2 maps these to `VisibilityBudgets` snake_case attributes.
pub(crate) const BUDGET_KEYS: [&str; 2] = ["maxTokens", "targetTokens"];

// ── validation diagnostic fragments (byte-exact from profiles.ts) ─

/// `initLhc config: view: ${detail}`
pub(crate) const DIAG_INIT_LHC_CONFIG_VIEW_PREFIX: &str = "initLhc config: view: ";

/// `profile "${name}": lowerBound must be a positive number, got ${…}`
pub(crate) const DIAG_PROFILE_PREFIX: &str = "profile \"";
pub(crate) const DIAG_PROFILE_LOWER_BOUND_MID: &str =
    "\": lowerBound must be a positive number, got ";
/// `profile "${name}": percentage ${key} must be a non-negative number, got ${…}`
pub(crate) const DIAG_PROFILE_PERCENTAGE_MID: &str = "\": percentage ";
pub(crate) const DIAG_PROFILE_PERCENTAGE_MUST_BE: &str = " must be a non-negative number, got ";
/// `profile "${name}": percentages must sum to 100, got ${…}`
pub(crate) const DIAG_PROFILE_PERCENTAGES_SUM_MID: &str = "\": percentages must sum to 100, got ";
/// `profile "${name}" is partial but overrides no built-in …`
pub(crate) const DIAG_PROFILE_PARTIAL_UNKNOWN_MID: &str =
    "\" is partial but overrides no built-in (unknown built-in override target); built-ins are ";
pub(crate) const DIAG_PROFILE_PARTIAL_UNKNOWN_SUFFIX: &str =
    " — a new profile must carry lowerBound and all four percentages";
/// `.map((p) => `"${p.name}"`).join(", ")` fragments for built-in / configured name lists.
pub(crate) const DIAG_PROFILE_NAME_QUOTE: &str = "\"";
pub(crate) const DIAG_PROFILE_NAME_LIST_JOIN: &str = ", ";
/// `visibility.${key} is not a budget field (budgets are maxTokens and targetTokens)`
pub(crate) const DIAG_VISIBILITY_PREFIX: &str = "visibility.";
pub(crate) const DIAG_VISIBILITY_NOT_BUDGET_FIELD: &str =
    " is not a budget field (budgets are maxTokens and targetTokens)";
/// `visibility.${key} must be a positive number, got ${…}`
pub(crate) const DIAG_VISIBILITY_MUST_BE_POSITIVE: &str = " must be a positive number, got ";
/// `visibility.maxTokens (${max}) must be greater than targetTokens (${target})`
pub(crate) const DIAG_VISIBILITY_MAX_TOKENS_OPEN: &str = "visibility.maxTokens (";
pub(crate) const DIAG_VISIBILITY_MAX_GT_TARGET_MID: &str = ") must be greater than targetTokens (";
pub(crate) const DIAG_VISIBILITY_MAX_GT_TARGET_CLOSE: &str = ")";
pub(crate) const DIAG_PROFILE_ENTRIES_NON_EMPTY_NAME: &str =
    "profile entries must carry a non-empty name";
/// `compactThreshold must be a positive number, got ${…}`
pub(crate) const DIAG_COMPACT_THRESHOLD_MUST_BE_POSITIVE: &str =
    "compactThreshold must be a positive number, got ";

fn fail(_detail: &str) -> ! {
    todo!("phase 2")
}

/// The violated constraint, named, or null when the profile is sound: one
/// rule set shared by both rejection surfaces — SDK construction (throws,
/// below) and compact invocation (caller-error result).
pub fn profile_violation(_profile: &ViewProfile) -> Option<String> {
    todo!("phase 2")
}

/// A complete, merged profile validates whole: positive lower bound, finite
/// non-negative shares, shares summing to exactly 100. Errors name the
/// violated constraint and the profile.
pub fn validate_profile(_profile: &ViewProfile) {
    todo!("phase 2")
}

fn is_complete_override(_entry: &ViewProfileOverride) -> bool {
    todo!("phase 2")
}

/// Merge one configured entry: field-wise over the built-in it names, or — for
/// a name no built-in carries — the entry must be complete, since there is
/// nothing to merge over.
fn merge_profile(_entry: &ViewProfileOverride, _base: Option<&ViewProfile>) -> ViewProfile {
    todo!("phase 2")
}

fn resolve_visibility(_partial: Option<&PartialVisibilityBudgets>) -> VisibilityBudgets {
    todo!("phase 2")
}

/// The one resolution path: built-ins, user profiles merged by name, every
/// resolved profile validated, visibility and threshold defaulted and checked.
/// Called from initLhc so validation runs through real construction.
pub fn resolve_view_config(_config: Option<&SdkViewConfig>) -> ResolvedViewConfig {
    todo!("phase 2")
}

/// Build the no-arg `resolveViewConfig()` result from real constant defaults.
/// Used for `DEFAULT_VIEW_CONFIG` without calling a todo at module init.
pub(crate) fn default_resolved_view_config() -> ResolvedViewConfig {
    let mut profiles = IndexMap::new();
    for built_in in BUILT_IN_PROFILES.iter() {
        profiles.insert(built_in.name.clone(), built_in.clone());
    }
    ResolvedViewConfig {
        profiles,
        visibility: DEFAULT_VISIBILITY,
        compact_threshold: DEFAULT_COMPACT_THRESHOLD,
    }
}
