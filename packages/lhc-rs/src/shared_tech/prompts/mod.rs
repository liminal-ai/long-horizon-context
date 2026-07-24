//! Ported from packages/lhc/src/shared-tech/prompts/index.ts.
//!
//! Name-keyed prompt registry: one module per template exporting
//! `{ name, render(input) → messages }`. Config selects by name, and dial-in
//! swaps by adding a module and editing config, with no handler, adapter, or
//! host changes. Versioning is in the name (`smoothing-v1`).

use crate::shared_tech::derivation::InferenceRequestMessage;

pub mod chunk_brief_v1;
pub mod chunk_brief_v2;
pub mod chunk_brief_v3;
pub mod detailed_turn_compression_v1;
pub mod detailed_turn_compression_v2;
pub mod detailed_turn_compression_v3;
pub mod smoothing_v1;
pub mod tool_result_v1;
pub mod tool_result_v2;

/// TS `PromptTemplate<I>` — name + typed render. Render returns the same
/// message shape as `ModelCallInput["messages"]` (role + content).
pub trait PromptTemplate {
    type Input;
    fn name(&self) -> &'static str;
    fn render(&self, input: &Self::Input) -> Vec<InferenceRequestMessage>;
}

/// Catalog entry for config-selectable prompts. Mirrors TS registry values
/// `{ name, render }` — render is type-erased over `serde_json::Value` like
/// TS `PromptTemplate<never>`.
#[derive(Debug, Clone, Copy)]
pub struct PromptCatalogEntry {
    pub name: &'static str,
    pub render: fn(&serde_json::Value) -> Vec<InferenceRequestMessage>,
}

/// Every config-selectable name. Rendering goes through the adapter, which
/// owns the only kind→input pairing. Insertion order matches the TS
/// `PROMPT_REGISTRY` object-literal key order.
pub const PROMPT_REGISTRY: &[PromptCatalogEntry] = &[
    PromptCatalogEntry {
        name: smoothing_v1::NAME,
        render: smoothing_v1::render_value,
    },
    PromptCatalogEntry {
        name: tool_result_v1::NAME,
        render: tool_result_v1::render_value,
    },
    PromptCatalogEntry {
        name: tool_result_v2::NAME,
        render: tool_result_v2::render_value,
    },
    PromptCatalogEntry {
        name: detailed_turn_compression_v1::NAME,
        render: detailed_turn_compression_v1::render_value,
    },
    PromptCatalogEntry {
        name: detailed_turn_compression_v2::NAME,
        render: detailed_turn_compression_v2::render_value,
    },
    PromptCatalogEntry {
        name: detailed_turn_compression_v3::NAME,
        render: detailed_turn_compression_v3::render_value,
    },
    PromptCatalogEntry {
        name: chunk_brief_v1::NAME,
        render: chunk_brief_v1::render_value,
    },
    PromptCatalogEntry {
        name: chunk_brief_v2::NAME,
        render: chunk_brief_v2::render_value,
    },
    PromptCatalogEntry {
        name: chunk_brief_v3::NAME,
        render: chunk_brief_v3::render_value,
    },
];

/// Look up a registry entry by template name.
pub fn registry_get(name: &str) -> Option<&'static PromptCatalogEntry> {
    PROMPT_REGISTRY.iter().find(|entry| entry.name == name)
}

/// Every config-selectable prompt name — the catalog an operator's assignment
/// config picks from. Exposed through the SDK surface so valid names are
/// discoverable without reading source.
pub const PROMPT_NAMES: &[&str] = &[
    smoothing_v1::NAME,
    tool_result_v1::NAME,
    tool_result_v2::NAME,
    detailed_turn_compression_v1::NAME,
    detailed_turn_compression_v2::NAME,
    detailed_turn_compression_v3::NAME,
    chunk_brief_v1::NAME,
    chunk_brief_v2::NAME,
    chunk_brief_v3::NAME,
];

/// The default template per derivation type — the defaults an operator's first
/// config reaches for, and what test fixtures assign.
pub const DEFAULT_PROMPT_NAMES: &[(&str, &str)] = &[
    ("smoothed_prompt", smoothing_v1::NAME),
    ("tool_result_summary", tool_result_v2::NAME),
    (
        "detailed_turn_compression",
        detailed_turn_compression_v3::NAME,
    ),
    ("chunk_summary_brief", chunk_brief_v3::NAME),
];
