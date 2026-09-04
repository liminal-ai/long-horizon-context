//! Ported from packages/lhc/test/content-blocks.test.ts (TS `157d88f`).
//!
//! Content blocks (images, documents, and every other non-text Messages API
//! block) through intake and serving. The rule under test: LHC holds every
//! block faithfully; binary/opaque payloads live in the blob table keyed by
//! content hash; text never carries base64 anywhere in the record; the tail
//! replays the real block; bands and every text reader see a short placeholder.

mod fixtures;

use fixtures::{ClosingDb, TempStore, temp_store, valid_event_forced};
use lhc::intake_stream::{EventKind, MessageEventInput};
use lhc::shared_tech::content_blocks::{
    base64_decode_node, base64_encode, extract_blobs, inline_blobs, placeholder_text,
};
use lhc::shared_tech::derivation::{SdkConfig, SdkMode};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::js_json::js_json_stringify;
use lhc::shared_tech::sha256::sha256_hex_bytes;
use lhc::shared_tech::view::{
    SessionAssistantPartType, SessionThreadViewEntry, SessionThreadViewMessage,
};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, create_deterministic_inference_callbacks, init_lhc, messages};
use serde_json::{Map, Value, json};

// A real 1x1 PNG and a stand-in PDF body; the bytes matter only as
// bytes — the hash and the length are what the record keeps.
const PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

fn png_len() -> usize {
    base64_decode_node(PNG_B64).len()
}

fn image_placeholder() -> String {
    format!("[image · image/png · {} B]", png_len())
}

fn pdf_b64() -> String {
    let body = format!("%PDF-1.4\n{}\n%%EOF", "x".repeat(120_000));
    base64_encode(body.as_bytes())
}

fn sha(b64: &str) -> String {
    sha256_hex_bytes(&base64_decode_node(b64))
}

fn image() -> Value {
    json!({ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": PNG_B64 } })
}

fn pdf() -> Value {
    json!({
        "type": "document",
        "source": { "type": "base64", "media_type": "application/pdf", "data": pdf_b64() },
        "title": "spec.pdf",
    })
}

fn obj(value: &Value) -> Map<String, Value> {
    value.as_object().expect("object").clone()
}

// ── content blocks: pure helpers ─────────────────────────────────

#[test]
fn extracts_base64_payloads_to_hash_keyed_blobs_and_inlines_them_back_byte_identical() {
    let text = json!({ "type": "text", "text": "look" });
    let extracted = extract_blobs(&[text.clone(), image(), pdf()]);
    let hashes: Vec<&str> = extracted.blobs.iter().map(|b| b.sha256.as_str()).collect();
    assert_eq!(hashes, vec![sha(PNG_B64), sha(&pdf_b64())]);
    assert_eq!(extracted.blobs[0].media_type.as_deref(), Some("image/png"));
    let rendered = js_json_stringify(&Value::Array(extracted.blocks.clone()));
    assert!(!rendered.contains(&PNG_B64[..24]));
    assert_eq!(
        extracted.blocks[1]["source"]["data"],
        json!({ "$blob": format!("sha256:{}", sha(PNG_B64)), "bytes": png_len() })
    );
    let store: Vec<(String, Vec<u8>)> = extracted
        .blobs
        .iter()
        .map(|b| (b.sha256.clone(), b.data.clone()))
        .collect();
    let load = |h: &str| store.iter().find(|(k, _)| k == h).map(|(_, d)| d.clone());
    let back = inline_blobs(&Value::Array(extracted.blocks.clone()), &load);
    assert_eq!(back, Value::Array(vec![text, image(), pdf()]));
}

#[test]
fn placeholders_name_the_block_media_type_size_and_title_never_the_content() {
    let redacted = json!({ "type": "redacted_thinking", "data": "opaque" });
    let extracted = extract_blobs(&[image(), pdf(), redacted]);
    assert_eq!(placeholder_text(&extracted.blocks[0]), image_placeholder());
    assert_eq!(
        placeholder_text(&extracted.blocks[1]),
        "[document · application/pdf · 117 KB · spec.pdf]"
    );
    assert_eq!(
        placeholder_text(&extracted.blocks[2]),
        "[redacted thinking]"
    );
    assert_eq!(
        placeholder_text(&json!({
            "type": "document",
            "source": { "type": "text", "media_type": "text/plain", "data": "plain body" }
        })),
        "plain body"
    );
}

#[test]
fn opaque_strings_redacted_thinking_encrypted_search_content_are_blobs_too() {
    let search = json!({
        "type": "web_search_tool_result",
        "tool_use_id": "srvtoolu_1",
        "content": [
            { "type": "web_search_result", "title": "T", "url": "https://x", "encrypted_content": "ENCRYPTED", "page_age": null },
        ],
    });
    let redacted = json!({ "type": "redacted_thinking", "data": "opaque" });
    let extracted = extract_blobs(&[search.clone(), redacted.clone()]);
    assert_eq!(extracted.blobs.len(), 2);
    assert!(!js_json_stringify(&Value::Array(extracted.blocks.clone())).contains("ENCRYPTED"));
    let store: Vec<(String, Vec<u8>)> = extracted
        .blobs
        .iter()
        .map(|b| (b.sha256.clone(), b.data.clone()))
        .collect();
    let load = |h: &str| store.iter().find(|(k, _)| k == h).map(|(_, d)| d.clone());
    assert_eq!(
        inline_blobs(&Value::Array(extracted.blocks.clone()), &load),
        Value::Array(vec![search, redacted])
    );
}

// ── content blocks: intake and serving ───────────────────────────

fn manual_sdk() -> Lhc {
    init_lhc(SdkConfig {
        mode: SdkMode::Manual,
        inference_callbacks: Some(create_deterministic_inference_callbacks()),
        inference: None,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    })
}

struct Harness {
    store: TempStore,
    sdk: Lhc,
    file_path: String,
}

async fn harness() -> Harness {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = store.thread_path(None).to_string_lossy().into_owned();
    let created = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: file_path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    if let OpResult::Err { error } = created {
        panic!("{}", error.reason);
    }
    Harness {
        store,
        sdk,
        file_path,
    }
}

impl Harness {
    fn thread_ref(&self) -> ThreadRef {
        ThreadRef::file_path(&self.file_path)
    }

    async fn intake(&self, events: &[MessageEventInput]) {
        let result = self
            .sdk
            .intake_stream
            .message_events(self.thread_ref(), events)
            .await;
        if let OpResult::Err { error } = result {
            panic!("{:?}: {}", error.code, error.reason);
        }
    }

    async fn bad(&self, event: MessageEventInput) -> String {
        let result = self
            .sdk
            .intake_stream
            .message_events(self.thread_ref(), std::slice::from_ref(&event))
            .await;
        match result {
            OpResult::Ok { .. } => panic!("expected the batch to be refused"),
            OpResult::Err { error } => error.reason,
        }
    }

    async fn view(&self) -> Vec<SessionThreadViewEntry> {
        match self
            .sdk
            .thread_view
            .get_session_thread_view(self.thread_ref())
            .await
        {
            OpResult::Ok { value } => value.entries,
            OpResult::Err { error } => panic!("{}", error.reason),
        }
    }

    fn cleanup(self) {
        self.store.cleanup();
    }
}

fn event(kind: EventKind, payload: Value) -> MessageEventInput {
    valid_event_forced(kind, json!({ "payload": payload }))
}

fn rows(db: &lhc::shared_tech::storage::Db, sql: &str) -> Vec<Map<String, Value>> {
    db.prepare(sql).all(&[])
}

fn str_col(row: &Map<String, Value>, key: &str) -> String {
    row.get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("column {key} is text: {row:?}"))
        .to_string()
}

fn user_entry(entry: &SessionThreadViewEntry) -> (&str, Option<&Vec<Map<String, Value>>>) {
    match entry {
        SessionThreadViewEntry::Message(SessionThreadViewMessage::User(m)) => {
            (m.content.as_str(), m.blocks.as_ref())
        }
        other => panic!("expected a user entry, got {other:?}"),
    }
}

#[tokio::test]
async fn a_prompt_with_an_image_and_a_read_of_a_png_blobs_stored_once_no_base64_in_any_text_the_tail_replays_the_real_blocks()
 {
    let h = harness().await;
    h.intake(&[
        event(
            EventKind::UserPrompt,
            json!({ "text": "what is this?", "blocks": [image(), { "type": "text", "text": "what is this?" }] }),
        ),
        event(
            EventKind::ToolCall,
            json!({ "toolCallId": "toolu_1", "toolName": "Read", "arguments": { "file_path": "shot.png" } }),
        ),
        event(
            EventKind::ToolResult,
            json!({ "toolCallId": "toolu_1", "content": "", "blocks": [image()] }),
        ),
        event(EventKind::AssistantText, json!({ "text": "A single pixel." })),
        event(EventKind::TurnEnd, json!({})),
    ])
    .await;

    {
        let closing = ClosingDb::open(&h.file_path);
        let db = closing.db();
        // One blob row for the same bytes sent twice.
        let blobs = rows(db, "SELECT sha256, media_type, byte_length FROM blob");
        assert_eq!(
            blobs,
            vec![obj(&json!({
                "sha256": sha(PNG_B64),
                "media_type": "image/png",
                "byte_length": png_len(),
            }))]
        );
        // No base64 anywhere in text: event payloads, message blocks.
        let marker = &PNG_B64[..24];
        for row in rows(db, "SELECT payload FROM event") {
            assert!(!str_col(&row, "payload").contains(marker));
        }
        for row in rows(db, "SELECT content FROM message_block") {
            assert!(!str_col(&row, "content").contains(marker));
        }
        // Block 0 is the text-shaped form with the placeholder; rows 1..n are the API blocks.
        let prompt_blocks = rows(
            db,
            "SELECT block_type, content FROM message_block WHERE message_id = 'm1' ORDER BY block_index",
        );
        let types: Vec<String> = prompt_blocks
            .iter()
            .map(|b| str_col(b, "block_type"))
            .collect();
        assert_eq!(types, vec!["text", "image", "text"]);
        let block0: Value = serde_json::from_str(&str_col(&prompt_blocks[0], "content")).unwrap();
        assert_eq!(
            block0["text"],
            json!(format!("{}\nwhat is this?", image_placeholder()))
        );
        let result_rows = rows(
            db,
            "SELECT content FROM message_block WHERE message_id = 'm3' AND block_index = 0",
        );
        let result_block0: Value =
            serde_json::from_str(&str_col(&result_rows[0], "content")).unwrap();
        assert_eq!(result_block0["content"], json!(image_placeholder()));
    }

    // messages.show returns the record with blob references, not bytes.
    let shown = messages::show(h.thread_ref(), "m1").await;
    let OpResult::Ok { value: shown } = shown else {
        panic!("show m1");
    };
    let shown_json = serde_json::to_value(&shown).expect("serializable");
    assert!(!js_json_stringify(&shown_json).contains(&PNG_B64[..24]));

    // The served tail carries the real content arrays, base64 back in place.
    let entries = h.view().await;
    assert!(entries.len() >= 4, "entries: {entries:?}");
    let (prompt_content, prompt_blocks) = user_entry(&entries[0]);
    assert_eq!(
        prompt_content,
        format!("{}\nwhat is this?", image_placeholder())
    );
    assert_eq!(
        prompt_blocks.cloned(),
        Some(vec![
            obj(&image()),
            obj(&json!({ "type": "text", "text": "what is this?" }))
        ])
    );
    assert!(matches!(
        entries[1],
        SessionThreadViewEntry::Message(SessionThreadViewMessage::Assistant(_))
    ));
    match &entries[2] {
        SessionThreadViewEntry::Message(SessionThreadViewMessage::ToolResult(result)) => {
            assert_eq!(result.tool_name.as_deref(), Some("Read"));
            assert_eq!(result.content, image_placeholder());
            assert_eq!(result.blocks.clone(), Some(vec![obj(&image())]));
        }
        other => panic!("expected toolResult, got {other:?}"),
    }
    match &entries[3] {
        SessionThreadViewEntry::Message(SessionThreadViewMessage::Assistant(reply)) => {
            assert_eq!(reply.content[0].text.as_deref(), Some("A single pixel."));
        }
        other => panic!("expected assistant, got {other:?}"),
    }
    h.cleanup();
}

#[tokio::test]
async fn a_pdf_document_block_is_a_blob_with_a_placeholder_that_names_the_title_text_only_prompts_are_unchanged()
 {
    let h = harness().await;
    h.intake(&[
        event(
            EventKind::UserPrompt,
            json!({
                "text": "What does section 3 say?",
                "blocks": [pdf(), { "type": "text", "text": "What does section 3 say?" }],
            }),
        ),
        event(
            EventKind::AssistantText,
            json!({ "text": "It says hello." }),
        ),
        event(EventKind::TurnEnd, json!({})),
        event(EventKind::UserPrompt, json!({ "text": "plain follow-up" })),
    ])
    .await;
    let entries = h.view().await;
    let (first_content, first_blocks) = user_entry(&entries[0]);
    assert_eq!(
        first_content,
        "[document · application/pdf · 117 KB · spec.pdf]\nWhat does section 3 say?"
    );
    assert_eq!(first_blocks.expect("blocks")[0], obj(&pdf()));
    let (plain_content, plain_blocks) = user_entry(&entries[2]);
    assert_eq!(plain_content, "plain follow-up");
    assert!(plain_blocks.is_none());
    let listed = messages::list(h.thread_ref(), None).await;
    let OpResult::Ok { value: listed } = listed else {
        panic!("list");
    };
    // The document's context cost is counted (≈2,000 tokens a page), not just its placeholder.
    assert!(
        listed[0].token_estimate > 4_000,
        "{}",
        listed[0].token_estimate
    );
    h.cleanup();
}

#[tokio::test]
async fn redacted_thinking_and_server_tool_blocks_come_back_inside_the_assistant_entry_verbatim() {
    let redacted = json!({ "type": "redacted_thinking", "data": "EqQBCkYIBRgCKkD" });
    let server_use = json!({
        "type": "server_tool_use",
        "id": "srvtoolu_1",
        "name": "web_search",
        "input": { "query": "lhc" },
        "caller": { "type": "direct" },
    });
    let server_result = json!({
        "type": "web_search_tool_result",
        "tool_use_id": "srvtoolu_1",
        "caller": { "type": "direct" },
        "content": [
            {
                "type": "web_search_result",
                "title": "LHC",
                "url": "https://example.com",
                "encrypted_content": "ENC",
                "page_age": null,
            },
        ],
    });
    let h = harness().await;
    h.intake(&[
        event(EventKind::UserPrompt, json!({ "text": "search" })),
        event(
            EventKind::AssistantThinking,
            json!({ "text": "", "block": redacted }),
        ),
        event(
            EventKind::ToolCall,
            json!({ "toolCallId": "srvtoolu_1", "toolName": "web_search", "arguments": { "query": "lhc" }, "block": server_use }),
        ),
        event(
            EventKind::ToolResult,
            json!({ "toolCallId": "srvtoolu_1", "content": "", "blocks": [server_result] }),
        ),
        event(EventKind::AssistantText, json!({ "text": "Found it." })),
        event(EventKind::TurnEnd, json!({})),
    ])
    .await;
    let entries = h.view().await;
    assert_eq!(entries.len(), 2, "{entries:?}");
    let SessionThreadViewEntry::Message(SessionThreadViewMessage::Assistant(assistant)) =
        &entries[1]
    else {
        panic!("expected assistant, got {:?}", entries[1]);
    };
    let types: Vec<SessionAssistantPartType> = assistant.content.iter().map(|p| p.type_).collect();
    assert_eq!(
        types,
        vec![
            SessionAssistantPartType::RedactedThinking,
            SessionAssistantPartType::ServerToolUse,
            SessionAssistantPartType::WebSearchToolResult,
            SessionAssistantPartType::Text,
        ]
    );
    assert_eq!(assistant.content[0].block.clone(), Some(obj(&redacted)));
    assert_eq!(assistant.content[1].block.clone(), Some(obj(&server_use)));
    assert_eq!(
        assistant.content[2].block.clone(),
        Some(obj(&server_result))
    );
    {
        let closing = ClosingDb::open(&h.file_path);
        let db = closing.db();
        for row in rows(db, "SELECT content FROM message_block") {
            assert!(!str_col(&row, "content").contains("ENC\""));
        }
        let m4 = rows(
            db,
            "SELECT content FROM message_block WHERE message_id = 'm4' AND block_index = 0",
        );
        let block0: Value = serde_json::from_str(&str_col(&m4[0], "content")).unwrap();
        assert!(
            block0["content"]
                .as_str()
                .unwrap()
                .contains("[web search result · 1 result(s)]"),
            "{block0}"
        );
    }
    h.cleanup();
}

#[tokio::test]
async fn refuses_blocks_that_are_not_messages_api_blocks_wrong_for_the_kind_or_not_base64() {
    let h = harness().await;
    assert!(
        h.bad(event(
            EventKind::UserPrompt,
            json!({ "text": "x", "blocks": [{ "type": "blob", "data": "zz" }] })
        ))
        .await
        .contains("not a Messages API content block")
    );
    assert!(
        h.bad(event(
            EventKind::UserPrompt,
            json!({ "text": "x", "blocks": [{ "type": "tool_use", "id": "t", "name": "n", "input": {} }] })
        ))
        .await
        .contains("not allowed here")
    );
    assert!(
        h.bad(event(
            EventKind::UserPrompt,
            json!({
                "text": "x",
                "blocks": [{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "not base64!" } }],
            })
        ))
        .await
        .contains("must be a base64 string")
    );
    assert!(
        h.bad(event(
            EventKind::AssistantThinking,
            json!({ "text": "", "block": image() })
        ))
        .await
        .contains("not allowed here")
    );
    h.cleanup();
}
