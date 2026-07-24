//! Wave 4 compile-shape: crate-root exposes ChunkRecord + LhcMessages::clean_prompt.
//! EditInput/RemoveInput absence at crate root is covered by trybuild UI cases.

use lhc::{ChunkRecord, LhcMessages, TurnRecord};

#[test]
fn crate_root_exports_chunk_record_beside_turn_record() {
    assert!(std::any::type_name::<ChunkRecord>().contains("ChunkRecord"));
    assert!(std::any::type_name::<TurnRecord>().contains("TurnRecord"));
}

#[test]
fn lhc_messages_clean_prompt_method_exists() {
    let _: fn(&LhcMessages, &str) -> String = LhcMessages::clean_prompt;
}
