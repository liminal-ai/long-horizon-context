//! PARTIAL stub — faithful signatures from packages/lhc/test/fixtures/threads.ts.
//! Bodies land when the threads fixture wave ports them.

use lhc::shared_tech::derivation::{Derivation, DerivationState, SubjectKind};

use super::TempStore;

/// TS `readDerivedForms` — PARTIAL.
pub fn read_derived_forms(_file_path: &str) -> Vec<Derivation> {
    todo!("phase 2")
}

/// TS `damagedSourceThread` — PARTIAL.
pub async fn damaged_source_thread(_store: &TempStore) -> DamagedSourceThreadResult {
    todo!("phase 2")
}

/// TS `multiStateThread` — PARTIAL.
pub async fn multi_state_thread(_store: &TempStore) -> MultiStateThreadResult {
    todo!("phase 2")
}

/// TS `threadWithClosedTurns` — PARTIAL.
pub async fn thread_with_closed_turns(
    _store: &TempStore,
    _n: usize,
) -> ThreadWithClosedTurnsResult {
    todo!("phase 2")
}

/// TS `threadWithToolRun` — PARTIAL.
pub async fn thread_with_tool_run(
    _store: &TempStore,
    _opts: Option<ToolRunOpts>,
) -> ThreadWithToolRunResult {
    todo!("phase 2")
}

#[derive(Debug, Clone)]
pub struct DamagedSourceThreadResult {
    pub file_path: String,
    pub turn_id: String,
}

#[derive(Debug, Clone)]
pub struct MultiStateClaim {
    pub subject_kind: SubjectKind,
    pub subject_id: String,
    pub derivation_type: String,
    pub state: DerivationState,
}

#[derive(Debug, Clone)]
pub struct MultiStateThreadResult {
    pub file_path: String,
    pub expected: Vec<MultiStateClaim>,
}

#[derive(Debug, Clone)]
pub struct ThreadWithClosedTurnsResult {
    pub file_path: String,
    pub turn_ids: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ToolRunOpts {
    pub is_error: Option<bool>,
    pub missing_result: Option<bool>,
    pub result_content: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ThreadWithToolRunResult {
    pub file_path: String,
    pub turn_id: String,
}
