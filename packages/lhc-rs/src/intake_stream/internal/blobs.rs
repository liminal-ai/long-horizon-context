//! Ported from packages/lhc/src/intake-stream/internal/blobs.ts.
//!
//! The one place an event payload's content blocks are rewritten: binary and
//! opaque payload strings leave for the blob table and `{ $blob, bytes }`
//! references take their place. Which payload keys carry blocks is fixed by the
//! intake types (`blocks` on user_prompt and tool_result, `block` on
//! assistant_thinking and tool_call); everything else passes through untouched.

use serde_json::{Map, Value};

use crate::shared_tech::content_blocks::{ExtractedBlob, extract_blobs};

/// TS `extractPayloadBlobs(payload)` → `{ payload, blobs }`.
pub fn extract_payload_blobs(
    payload: &Map<String, Value>,
) -> (Map<String, Value>, Vec<ExtractedBlob>) {
    if let Some(Value::Array(blocks)) = payload.get("blocks") {
        let extracted = extract_blobs(blocks);
        let mut out = payload.clone();
        out.insert("blocks".into(), Value::Array(extracted.blocks));
        return (out, extracted.blobs);
    }
    if let Some(block @ Value::Object(_)) = payload.get("block") {
        let extracted = extract_blobs(std::slice::from_ref(block));
        let mut out = payload.clone();
        out.insert(
            "block".into(),
            extracted.blocks.into_iter().next().unwrap_or(Value::Null),
        );
        return (out, extracted.blobs);
    }
    (payload.clone(), Vec::new())
}
