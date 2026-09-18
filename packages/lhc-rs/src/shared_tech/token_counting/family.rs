//! Serving-model correction for raw o200k estimates. Persistence and slicing
//! continue to use the raw tokenizer; only budget/read accounting uses this.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum TokenFamily {
    #[default]
    O200k,
    Grok,
}

impl TokenFamily {
    pub(crate) fn for_model(model: &str) -> Self {
        if model.starts_with("grok-") {
            Self::Grok
        } else {
            Self::O200k
        }
    }

    pub(crate) fn weigh(self, raw: i64) -> i64 {
        match self {
            Self::O200k => raw,
            // Integer ceil(raw * 1.05), avoiding floating-point boundary drift.
            Self::Grok => ((i128::from(raw) * 21 + 19) / 20).min(i128::from(i64::MAX)) as i64,
        }
    }
}

/// Budget cost under the serving model captured at the start of this operation.
pub(crate) fn weigh_tokens(raw: i64) -> i64 {
    crate::shared_tech::context::resolve_token_family().weigh(raw)
}

pub(crate) fn estimate_budget_tokens(text: &str) -> i64 {
    weigh_tokens(super::estimate_tokens(text))
}

#[cfg(test)]
#[path = "family_tests.rs"]
mod tests;
