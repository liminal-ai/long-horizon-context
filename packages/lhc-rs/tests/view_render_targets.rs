//! Ported from packages/lhc/test/view-render-targets.test.ts. Phase 1.
//!
//! Epic 03 Story 5: render targets (TC-5.1, TC-5.2, TC-5.3, TC-5.5).
//!
//! Judgment: Rust has no async beforeAll — each test builds a fresh
//! fixture (acceptable isolation translation of TS file-level `beforeAll`).

mod fixtures;

use std::path::PathBuf;

use fixtures::{
    DerivedThreadFixture, DerivedThreadOptions, TempStore, assert_pi_session_conformance,
    create_inference_callbacks_double, derived_thread_fixture, event_batch, open_raw, temp_store,
};
use lhc::intake_stream::EventKind;
use lhc::shared_tech::derivation::{SdkConfig, SdkMode};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::shared_tech::js_json::js_json_stringify;
use lhc::shared_tech::storage::Db;
use lhc::shared_tech::view::{
    LlmRequestContextMessage, LlmRequestContextPart, LlmRequestContextPartType,
    LlmRequestContextRole, PartialViewProfilePercentages, ViewCompactParams,
};
use lhc::thread_view::{CompactOpts, MaterializeOpts};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, init_lhc};
use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value};

/// All three bands non-empty (Story 2's reference config).
fn gradient_params() -> ViewCompactParams {
    ViewCompactParams {
        lower_bound: Some(400.0),
        percentages: Some(PartialViewProfilePercentages {
            full: Some(25.0),
            smooth: Some(16.0),
            detailed: Some(10.0),
            brief: Some(49.0),
        }),
    }
}

fn sha256_hex(data: &[u8]) -> String {
    fn rotr(x: u32, n: u32) -> u32 {
        (x >> n) | (x << (32 - n))
    }
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let bit_len = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
            let s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    h.iter().map(|v| format!("{v:08x}")).collect()
}

fn db_rows(db: &Db, sql: &str) -> Vec<Map<String, Value>> {
    db.prepare(sql).all(&[])
}

/// Full thread-file state, view rows and boundary included.
fn full_state_hash(file_path: &str) -> String {
    let db = open_raw(file_path);
    let tables: [(&str, &str); 11] = [
        ("events", "SELECT * FROM event ORDER BY event_order"),
        (
            "messages",
            "SELECT * FROM message ORDER BY source_event_order",
        ),
        (
            "blocks",
            "SELECT * FROM message_block ORDER BY message_id, block_index",
        ),
        ("turns", "SELECT * FROM turns ORDER BY turn_order"),
        ("chunks", "SELECT * FROM chunk ORDER BY chunk_order"),
        (
            "members",
            "SELECT * FROM chunk_member ORDER BY chunk_id, member_idx",
        ),
        (
            "derivations",
            "SELECT * FROM derivation ORDER BY subject_kind, subject_id, derivation_type",
        ),
        ("views", "SELECT * FROM thread_view"),
        ("bands", "SELECT * FROM thread_view_band ORDER BY band"),
        ("boundary", "SELECT * FROM view_boundary"),
        ("work", "SELECT * FROM work_item ORDER BY work_item_id"),
    ];
    let mut payload = Map::new();
    for (key, sql) in tables {
        payload.insert(
            key.into(),
            Value::Array(db_rows(&db, sql).into_iter().map(Value::Object).collect()),
        );
    }
    db.close();
    sha256_hex(js_json_stringify(&Value::Object(payload)).as_bytes())
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionMessagePart {
    #[serde(rename = "type")]
    type_: String,
    text: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionMessage {
    role: String,
    content: Vec<SessionMessagePart>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionEntry {
    #[serde(rename = "type")]
    type_: String,
    id: String,
    parent_id: Option<String>,
    timestamp: String,
    message: SessionMessage,
}

#[derive(Debug, Clone, PartialEq)]
struct SessionFile {
    text: String,
    header: Map<String, Value>,
    entries: Vec<SessionEntry>,
}

fn read_session_file(path: &str) -> SessionFile {
    let text = std::fs::read_to_string(path).expect("read session file");
    let lines: Vec<&str> = text.split('\n').filter(|line| *line != "").collect();
    let header: Map<String, Value> =
        serde_json::from_str(lines.first().copied().unwrap_or("{}")).expect("header json");
    let entries = lines[1..]
        .iter()
        .map(|line| serde_json::from_str(line).expect("entry json"))
        .collect();
    SessionFile {
        text,
        header,
        entries,
    }
}

fn message_text(message: Option<&LlmRequestContextMessage>) -> Option<String> {
    message.map(|m| m.content.iter().map(|part| part.text.as_str()).collect())
}

fn content_as_values(parts: &[LlmRequestContextPart]) -> Vec<Value> {
    parts
        .iter()
        .map(|p| {
            serde_json::json!({
                "type": p.type_.as_str(),
                "text": p.text,
            })
        })
        .collect()
}

fn entry_content_as_values(parts: &[SessionMessagePart]) -> Vec<Value> {
    parts
        .iter()
        .map(|p| {
            serde_json::json!({
                "type": p.type_,
                "text": p.text,
            })
        })
        .collect()
}

async fn fresh_fixture() -> (TempStore, DerivedThreadFixture) {
    let store = temp_store();
    let fixture = derived_thread_fixture(&store, DerivedThreadOptions { failures: None }).await;
    (store, fixture)
}

#[tokio::test]
async fn bands_brief_detailed_smooth_with_labels_then_the_tail_repeated_contexts_byte_identical() {
    let (_store, fixture) = fresh_fixture().await;
    let ref_path = &fixture.file_path;

    let compacted = fixture
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(ref_path),
            CompactOpts {
                profile: None,
                params: Some(gradient_params()),
                signal: None,
                compact_point_upper_bound: None,
            },
        )
        .await;
    assert!(compacted.is_ok());

    let first = fixture
        .sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(ref_path))
        .await;
    assert!(first.is_ok());
    let OpResult::Ok { value: first } = first else {
        return;
    };
    let messages = &first.messages;
    let texts: Vec<Option<String>> = messages.iter().map(|m| message_text(Some(m))).collect();

    let band_texts: Vec<&Option<String>> = texts
        .iter()
        .filter(|text| text.as_ref().is_some_and(|t| t.starts_with("[context ·")))
        .collect();
    let band_re = Regex::new(r"^\[context · ([^\]]+)\]").expect("regex");
    let band_names: Vec<Option<String>> = band_texts
        .iter()
        .map(|text| {
            text.as_ref()
                .and_then(|t| band_re.captures(t))
                .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
        })
        .collect();
    assert_eq!(
        band_names,
        [
            Some("brief".into()),
            Some("detailed".into()),
            Some("smooth".into())
        ]
    );
    for i in 0..band_texts.len() {
        assert_eq!(messages[i].role, LlmRequestContextRole::User);
    }
    let band_texts_owned: Vec<Option<String>> = band_texts.iter().map(|t| (*t).clone()).collect();
    assert_eq!(&texts[..band_texts.len()], band_texts_owned.as_slice());

    let tail = &messages[band_texts.len()..];
    let tail_texts: Vec<Option<String>> = tail.iter().map(|m| message_text(Some(m))).collect();
    assert_eq!(
        &tail[0],
        &LlmRequestContextMessage {
            role: LlmRequestContextRole::User,
            content: vec![LlmRequestContextPart {
                type_: LlmRequestContextPartType::Text,
                text: "turn 9: please investigate area 9".into(),
            }],
        }
    );
    let prompts: Vec<&str> = tail_texts
        .iter()
        .filter_map(|text| text.as_ref())
        .filter(|text| text.starts_with("turn "))
        .map(|text| text.split(':').next().unwrap_or(""))
        .collect();
    assert_eq!(prompts, ["turn 9", "turn 10", "turn 11", "turn 12"]);
    for m in tail {
        let text = message_text(Some(m)).unwrap_or_default();
        if text.starts_with("[tool call") || text.starts_with("[thinking]") {
            assert_eq!(m.role, LlmRequestContextRole::Assistant);
        }
        if text.starts_with("[tool result") {
            assert_eq!(m.role, LlmRequestContextRole::User);
        }
    }

    let second = fixture
        .sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(ref_path))
        .await;
    assert!(second.is_ok());
    let OpResult::Ok { value: second } = second else {
        return;
    };
    assert_eq!(
        js_json_stringify(&serde_json::to_value(&second).expect("ser")),
        js_json_stringify(&serde_json::to_value(&first).expect("ser"))
    );
}

#[tokio::test]
async fn every_model_context_message_appears_in_the_file_same_order_same_text_repeat_is_byte_identical_state_hash_unchanged()
 {
    let (store, fixture) = fresh_fixture().await;
    let ref_path = &fixture.file_path;
    let out_path: PathBuf = store.dir.join("render-parity.jsonl");
    let out_path_str = out_path.to_string_lossy().into_owned();

    let compacted = fixture
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(ref_path),
            CompactOpts {
                profile: None,
                params: Some(gradient_params()),
                signal: None,
                compact_point_upper_bound: None,
            },
        )
        .await;
    assert!(compacted.is_ok());
    let context_messages = fixture
        .sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(ref_path))
        .await;
    assert!(context_messages.is_ok());
    let OpResult::Ok {
        value: context_messages,
    } = context_messages
    else {
        return;
    };

    let before = full_state_hash(ref_path);
    let materialized = fixture
        .sdk
        .thread_view
        .materialize(
            ThreadRef::file_path(ref_path),
            MaterializeOpts {
                path: out_path_str.clone(),
                format: None,
            },
        )
        .await;
    assert!(materialized.is_ok());
    let OpResult::Ok {
        value: materialized,
    } = materialized
    else {
        return;
    };
    assert_eq!(materialized.written_path, out_path_str);

    let file = read_session_file(&out_path_str);
    assert_eq!(file.entries.len(), context_messages.messages.len());
    for (i, entry) in file.entries.iter().enumerate() {
        let source = &context_messages.messages[i];
        assert_eq!(entry.message.role, source.role.as_str());
        assert_eq!(
            entry_content_as_values(&entry.message.content),
            content_as_values(&source.content)
        );
    }

    let described = fixture
        .sdk
        .thread_view
        .describe(ThreadRef::file_path(ref_path))
        .await;
    assert!(described.is_ok());
    let OpResult::Ok { value: described } = described else {
        return;
    };
    let Some(described) = described else {
        return;
    };
    assert_eq!(file.entries[0].timestamp, described.created_at);
    assert_eq!(file.entries[0].id, format!("{}-brief", described.view_id));
    assert_eq!(
        file.header.get("timestamp").and_then(|v| v.as_str()),
        Some(described.created_at.as_str())
    );

    let again = fixture
        .sdk
        .thread_view
        .materialize(
            ThreadRef::file_path(ref_path),
            MaterializeOpts {
                path: out_path_str.clone(),
                format: None,
            },
        )
        .await;
    assert!(again.is_ok());
    let again_bytes = std::fs::read(&out_path_str).expect("reread");
    assert_eq!(sha256_hex(&again_bytes), sha256_hex(file.text.as_bytes()));

    assert_eq!(full_state_hash(ref_path), before);
}

#[tokio::test]
async fn rejects_an_unknown_format_naming_the_accepted_values_writing_nothing() {
    let (store, fixture) = fresh_fixture().await;
    let out_path = store.dir.join("never-written.jsonl");
    let out_path_str = out_path.to_string_lossy().into_owned();

    // TS: format: "markdown" as "pi-session" — runtime string, closed-type bypass.
    let result = fixture
        .sdk
        .thread_view
        .materialize(
            ThreadRef::file_path(&fixture.file_path),
            MaterializeOpts {
                path: out_path_str.clone(),
                format: Some("markdown".into()),
            },
        )
        .await;
    assert!(!result.is_ok());
    let OpResult::Err { error } = result else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
    assert_eq!(error.code, ErrorCode::UnknownFormat);
    assert!(error.reason.contains("pi-session"));
    // Assert the read THROWS (Result err), not mere path nonexistence.
    let read = std::fs::read_to_string(&out_path_str);
    assert!(read.is_err(), "expected file read to fail, got Ok");
}

#[tokio::test]
async fn valid_file_tail_only_content_loadable_against_the_format_fixture_header_from_the_threads_created_at()
 {
    let store = temp_store();
    let sdk: Lhc = init_lhc(SdkConfig {
        inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    let file_path = store
        .thread_path(Some("never-compacted"))
        .to_string_lossy()
        .into_owned();
    let created = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: file_path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    assert!(created.is_ok());
    let mut batch = event_batch(&[
        EventKind::UserPrompt,
        EventKind::AssistantText,
        EventKind::TurnEnd,
    ]);
    batch.extend(event_batch(&[
        EventKind::UserPrompt,
        EventKind::AssistantText,
    ]));
    let seeded = sdk
        .intake_stream
        .message_events(ThreadRef::file_path(&file_path), &batch)
        .await;
    assert!(seeded.is_ok());

    let out_path = store.dir.join("tail-only.jsonl");
    let out_path_str = out_path.to_string_lossy().into_owned();
    let materialized = sdk
        .thread_view
        .materialize(
            ThreadRef::file_path(&file_path),
            MaterializeOpts {
                path: out_path_str.clone(),
                format: None,
            },
        )
        .await;
    assert!(materialized.is_ok());

    let file = read_session_file(&out_path_str);
    assert_pi_session_conformance(&file.text);

    let context_messages = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(context_messages.is_ok());
    let OpResult::Ok {
        value: context_messages,
    } = context_messages
    else {
        return;
    };
    let described = sdk
        .thread_view
        .describe(ThreadRef::file_path(&file_path))
        .await;
    assert!(described.is_ok());
    let OpResult::Ok { value: described } = described else {
        return;
    };
    assert!(described.is_none());
    assert_eq!(file.entries.len(), 4);
    assert!(file.entries.iter().all(|e| {
        e.message
            .content
            .first()
            .map(|c| !c.text.starts_with("[context ·"))
            .unwrap_or(true)
    }));
    for (i, entry) in file.entries.iter().enumerate() {
        assert_eq!(
            entry_content_as_values(&entry.message.content),
            content_as_values(&context_messages.messages[i].content)
        );
    }

    let db = open_raw(&file_path);
    let meta = db
        .prepare("SELECT thread_id, created_at FROM thread_metadata WHERE id = 1")
        .get()
        .expect("thread_metadata");
    db.close();
    assert_eq!(
        file.header.get("timestamp").and_then(|v| v.as_str()),
        meta.get("created_at").and_then(|v| v.as_str())
    );
    let expected_id = format!(
        "{}:{}",
        meta.get("thread_id")
            .and_then(|v| v.as_str())
            .expect("thread_metadata.thread_id"),
        meta.get("created_at")
            .and_then(|v| v.as_str())
            .expect("thread_metadata.created_at")
    );
    assert_eq!(
        file.header.get("id").and_then(|v| v.as_str()),
        Some(expected_id.as_str())
    );
}

#[tokio::test]
async fn header_line_entry_shape_parentid_chain_message_encoding_all_validate() {
    let (store, fixture) = fresh_fixture().await;
    let ref_path = &fixture.file_path;
    let out_path = store.dir.join("conformance.jsonl");
    let out_path_str = out_path.to_string_lossy().into_owned();

    let compacted = fixture
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(ref_path),
            CompactOpts {
                profile: None,
                params: Some(gradient_params()),
                signal: None,
                compact_point_upper_bound: None,
            },
        )
        .await;
    assert!(compacted.is_ok());
    let materialized = fixture
        .sdk
        .thread_view
        .materialize(
            ThreadRef::file_path(ref_path),
            MaterializeOpts {
                path: out_path_str.clone(),
                format: None,
            },
        )
        .await;
    assert!(materialized.is_ok());

    let file = read_session_file(&out_path_str);
    assert_pi_session_conformance(&file.text);

    assert!(file.entries[0].parent_id.is_none());
    for i in 1..file.entries.len() {
        assert_eq!(
            file.entries[i].parent_id.as_deref(),
            Some(file.entries[i - 1].id.as_str())
        );
    }
}
