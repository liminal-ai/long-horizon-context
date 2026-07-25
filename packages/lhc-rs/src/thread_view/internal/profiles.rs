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

use std::sync::LazyLock;

use indexmap::IndexMap;

use crate::shared_tech::js_json::{js_len, js_string_of_number};
use crate::shared_tech::view::{
    PartialVisibilityBudgets, ResolvedViewConfig, SdkViewConfig, ViewProfile, ViewProfileOverride,
    ViewProfilePercentages, VisibilityBudgets,
};

/// Built-in profiles: defaults and knobs, not architecture.
pub static BUILT_IN_PROFILES: LazyLock<Vec<ViewProfile>> = LazyLock::new(|| {
    vec![
        ViewProfile {
            name: "continuation".to_string(),
            lower_bound: 120000.0,
            percentages: ViewProfilePercentages {
                full: 30.0,
                smooth: 30.0,
                detailed: 20.0,
                brief: 20.0,
            },
        },
        ViewProfile {
            name: "conversation".to_string(),
            lower_bound: 120000.0,
            percentages: ViewProfilePercentages {
                full: 12.0,
                smooth: 48.0,
                detailed: 20.0,
                brief: 20.0,
            },
        },
        ViewProfile {
            name: "coding".to_string(),
            lower_bound: 120000.0,
            percentages: ViewProfilePercentages {
                full: 25.0,
                smooth: 35.0,
                detailed: 20.0,
                brief: 20.0,
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

fn fail(detail: &str) -> ! {
    panic!("{}{detail}", DIAG_INIT_LHC_CONFIG_VIEW_PREFIX);
}

/// The violated constraint, named, or null when the profile is sound: one
/// rule set shared by both rejection surfaces — SDK construction (throws,
/// below) and compact invocation (caller-error result).
pub fn profile_violation(profile: &ViewProfile) -> Option<String> {
    if !profile.lower_bound.is_finite() || profile.lower_bound <= 0.0 {
        return Some(format!(
            "{}{}{}{}",
            DIAG_PROFILE_PREFIX,
            profile.name,
            DIAG_PROFILE_LOWER_BOUND_MID,
            js_string_of_number(profile.lower_bound),
        ));
    }
    // Closed band shares — direct field access (no string-key wildcard match).
    let band_shares: [(&str, f64); 4] = [
        ("full", profile.percentages.full),
        ("smooth", profile.percentages.smooth),
        ("detailed", profile.percentages.detailed),
        ("brief", profile.percentages.brief),
    ];
    for (key, share) in band_shares {
        if !share.is_finite() || share < 0.0 {
            return Some(format!(
                "{}{}{}{}{}{}",
                DIAG_PROFILE_PREFIX,
                profile.name,
                DIAG_PROFILE_PERCENTAGE_MID,
                key,
                DIAG_PROFILE_PERCENTAGE_MUST_BE,
                js_string_of_number(share),
            ));
        }
    }
    let sum = profile.percentages.full
        + profile.percentages.smooth
        + profile.percentages.detailed
        + profile.percentages.brief;
    if sum != 100.0 {
        return Some(format!(
            "{}{}{}{}",
            DIAG_PROFILE_PREFIX,
            profile.name,
            DIAG_PROFILE_PERCENTAGES_SUM_MID,
            js_string_of_number(sum),
        ));
    }
    None
}

/// A complete, merged profile validates whole: positive lower bound, finite
/// non-negative shares, shares summing to exactly 100. Errors name the
/// violated constraint and the profile.
pub fn validate_profile(profile: &ViewProfile) {
    if let Some(violation) = profile_violation(profile) {
        fail(&violation);
    }
}

fn is_complete_override(entry: &ViewProfileOverride) -> bool {
    let Some(percentages) = entry.percentages.as_ref() else {
        return false;
    };
    entry.lower_bound.is_some()
        && percentages.full.is_some()
        && percentages.smooth.is_some()
        && percentages.detailed.is_some()
        && percentages.brief.is_some()
}

/// Merge one configured entry: field-wise over the built-in it names, or — for
/// a name no built-in carries — the entry must be complete, since there is
/// nothing to merge over.
fn merge_profile(entry: &ViewProfileOverride, base: Option<&ViewProfile>) -> ViewProfile {
    let Some(base) = base else {
        if !is_complete_override(entry) {
            let built_ins = BUILT_IN_PROFILES
                .iter()
                .map(|p| {
                    format!(
                        "{}{}{}",
                        DIAG_PROFILE_NAME_QUOTE, p.name, DIAG_PROFILE_NAME_QUOTE
                    )
                })
                .collect::<Vec<_>>()
                .join(DIAG_PROFILE_NAME_LIST_JOIN);
            fail(&format!(
                "{}{}{}{}{}",
                DIAG_PROFILE_PREFIX,
                entry.name,
                DIAG_PROFILE_PARTIAL_UNKNOWN_MID,
                built_ins,
                DIAG_PROFILE_PARTIAL_UNKNOWN_SUFFIX,
            ));
        }
        let percentages = entry.percentages.as_ref().expect("complete override");
        return ViewProfile {
            name: entry.name.clone(),
            lower_bound: entry.lower_bound.expect("complete override"),
            percentages: ViewProfilePercentages {
                full: percentages.full.expect("complete override"),
                smooth: percentages.smooth.expect("complete override"),
                detailed: percentages.detailed.expect("complete override"),
                brief: percentages.brief.expect("complete override"),
            },
        };
    };
    let override_pct = entry.percentages.as_ref();
    ViewProfile {
        name: entry.name.clone(),
        lower_bound: entry.lower_bound.unwrap_or(base.lower_bound),
        percentages: ViewProfilePercentages {
            full: override_pct
                .and_then(|p| p.full)
                .unwrap_or(base.percentages.full),
            smooth: override_pct
                .and_then(|p| p.smooth)
                .unwrap_or(base.percentages.smooth),
            detailed: override_pct
                .and_then(|p| p.detailed)
                .unwrap_or(base.percentages.detailed),
            brief: override_pct
                .and_then(|p| p.brief)
                .unwrap_or(base.percentages.brief),
        },
    }
}

fn visibility_raw_keys(partial: Option<&PartialVisibilityBudgets>) -> Vec<&'static str> {
    let Some(partial) = partial else {
        return Vec::new();
    };
    // Typed path: only emit keys that were conceptually "present". TS
    // Object.keys skips undefined; None fields are absent (Python dataclass path).
    let mut keys = Vec::new();
    if partial.max_tokens.is_some() {
        keys.push("maxTokens");
    }
    if partial.target_tokens.is_some() {
        keys.push("targetTokens");
    }
    keys
}

fn resolve_visibility(partial: Option<&PartialVisibilityBudgets>) -> VisibilityBudgets {
    // Unknown budget fields are config mistakes, not silent passengers.
    for key in visibility_raw_keys(partial) {
        if !BUDGET_KEYS.contains(&key) {
            fail(&format!(
                "{}{}{}",
                DIAG_VISIBILITY_PREFIX, key, DIAG_VISIBILITY_NOT_BUDGET_FIELD
            ));
        }
    }
    let visibility = VisibilityBudgets {
        max_tokens: partial
            .and_then(|p| p.max_tokens)
            .unwrap_or(DEFAULT_VISIBILITY.max_tokens),
        target_tokens: partial
            .and_then(|p| p.target_tokens)
            .unwrap_or(DEFAULT_VISIBILITY.target_tokens),
    };
    // Closed budget fields — direct access (no string-key wildcard match).
    for (key, value) in [
        ("maxTokens", visibility.max_tokens),
        ("targetTokens", visibility.target_tokens),
    ] {
        if !value.is_finite() || value <= 0.0 {
            fail(&format!(
                "{}{}{}{}",
                DIAG_VISIBILITY_PREFIX,
                key,
                DIAG_VISIBILITY_MUST_BE_POSITIVE,
                js_string_of_number(value),
            ));
        }
    }
    // The budget ordering rule: max > target.
    if visibility.max_tokens <= visibility.target_tokens {
        fail(&format!(
            "{}{}{}{}{}",
            DIAG_VISIBILITY_MAX_TOKENS_OPEN,
            js_string_of_number(visibility.max_tokens),
            DIAG_VISIBILITY_MAX_GT_TARGET_MID,
            js_string_of_number(visibility.target_tokens),
            DIAG_VISIBILITY_MAX_GT_TARGET_CLOSE,
        ));
    }
    visibility
}

/// The one resolution path: built-ins, user profiles merged by name, every
/// resolved profile validated, visibility and threshold defaulted and checked.
/// Called from initLhc so validation runs through real construction.
pub fn resolve_view_config(config: Option<&SdkViewConfig>) -> ResolvedViewConfig {
    let mut profiles: IndexMap<String, ViewProfile> = IndexMap::new();
    for built_in in BUILT_IN_PROFILES.iter() {
        profiles.insert(built_in.name.clone(), built_in.clone());
    }
    let entries = config.and_then(|c| c.profiles.as_deref()).unwrap_or(&[]);
    for entry in entries {
        if js_len(&entry.name) == 0 {
            fail(DIAG_PROFILE_ENTRIES_NON_EMPTY_NAME);
        }
        let base = profiles.get(&entry.name).cloned();
        profiles.insert(entry.name.clone(), merge_profile(entry, base.as_ref()));
    }
    for profile in profiles.values() {
        validate_profile(profile);
    }

    let compact_threshold = config
        .and_then(|c| c.compact_threshold)
        .unwrap_or(DEFAULT_COMPACT_THRESHOLD);
    if !compact_threshold.is_finite() || compact_threshold <= 0.0 {
        fail(&format!(
            "{}{}",
            DIAG_COMPACT_THRESHOLD_MUST_BE_POSITIVE,
            js_string_of_number(compact_threshold),
        ));
    }

    ResolvedViewConfig {
        profiles,
        visibility: resolve_visibility(config.and_then(|c| c.visibility.as_ref())),
        compact_threshold,
    }
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
