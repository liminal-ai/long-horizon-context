//! Ported from packages/lhc/test/fixtures/pi-session-format.ts. Phase 1.
//!
//! PI session format conformance (TC-5.3/TC-5.5): the required shapes are
//! DERIVED from the structure-trimmed real PI session fixture at runtime,
//! never restated from the design — the fixture's job is to catch the design
//! being wrong about PI, which a design-derived checker could not
//! (provenance: pi-session-structure.provenance.md). Checks are
//! structure-level: header line shape, entry shape, parentId chain, message
//! encoding.
//!
//! Pure file I/O + validation — REAL in Phase 1.

use std::collections::BTreeSet;
use std::path::PathBuf;

use serde_json::{Map, Value};

use lhc::shared_tech::js_json::js_json_stringify;

/// TS `ParsedSession` — named struct (dot-accessed); required fields required.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedSession {
    pub header: Map<String, Value>,
    pub entries: Vec<Map<String, Value>>,
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pi-session-structure.jsonl")
}

fn parse_jsonl(text: &str, label: &str) -> ParsedSession {
    let lines: Vec<&str> = text.split('\n').filter(|line| *line != "").collect();
    if lines.is_empty() {
        panic!("{label}: empty file");
    }
    let mut parsed: Vec<Map<String, Value>> = Vec::with_capacity(lines.len());
    for (i, line) in lines.iter().enumerate() {
        // Propagate serde's parse error directly (TS `JSON.parse` throw text).
        let value: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => panic!("{e}"),
        };
        // TS: typeof !== "object" || null || Array.isArray → not a JSON object.
        let Value::Object(obj) = value else {
            panic!("{label} line {}: not a JSON object", i + 1);
        };
        parsed.push(obj);
    }
    let mut iter = parsed.into_iter();
    let header = iter
        .next()
        .unwrap_or_else(|| panic!("{label}: no header line"));
    ParsedSession {
        header,
        entries: iter.collect(),
    }
}

/// TS `loadPiSessionFixture`.
pub fn load_pi_session_fixture() -> ParsedSession {
    // Bare filesystem error text (same policy as bare serde parse errors).
    let text = std::fs::read_to_string(fixture_path()).unwrap_or_else(|e| panic!("{e}"));
    parse_jsonl(&text, "pi-session-structure fixture")
}

fn key_set(value: &Map<String, Value>) -> String {
    let mut keys: Vec<&str> = value.keys().map(String::as_str).collect();
    keys.sort_unstable();
    keys.join(",")
}

/// TS `Object.keys(array).sort().join(",")` — non-empty arrays yield index
/// keys `"0,1,…"`, empty arrays yield `""`.
fn js_array_key_set(len: usize) -> String {
    (0..len)
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

fn js_typeof(value: &Value) -> &'static str {
    match value {
        Value::Null => "object", // JS typeof null === "object"
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "object",
        Value::Object(_) => "object",
    }
}

/// TS `JSON.stringify(actual)` in fail templates — missing keys are JS
/// `undefined` (template → `"undefined"`), not JSON `null`.
fn js_json_stringify_or_undefined(actual: Option<&Value>) -> String {
    match actual {
        None => "undefined".to_string(),
        Some(v) => js_json_stringify(v),
    }
}

fn fail(where_: &str, expected: &str, actual: Option<&Value>) -> ! {
    panic!(
        "pi-session conformance violation at {where_}: expected {expected}, got {}",
        js_json_stringify_or_undefined(actual)
    );
}

/// TS `assertPiSessionConformance` — validates a materialized file's structure
/// against the real-PI fixture.
pub fn assert_pi_session_conformance(materialized_text: &str) {
    let fixture = load_pi_session_fixture();
    let file = parse_jsonl(materialized_text, "materialized session");

    // Header shape derived from the fixture header.
    if file.header.get("type") != Some(&Value::String("session".into())) {
        fail("header.type", "\"session\"", file.header.get("type"));
    }
    if key_set(&file.header) != key_set(&fixture.header) {
        fail(
            "header keys",
            &key_set(&fixture.header),
            Some(&Value::String(key_set(&file.header))),
        );
    }
    for (key, fixture_value) in &fixture.header {
        match file.header.get(key) {
            None => fail(
                &format!("header.{key} type"),
                js_typeof(fixture_value),
                None,
            ),
            Some(file_value) if js_typeof(file_value) != js_typeof(fixture_value) => {
                fail(
                    &format!("header.{key} type"),
                    js_typeof(fixture_value),
                    Some(file_value),
                );
            }
            Some(_) => {}
        }
    }

    // Entry shape derived from the fixture's message entries.
    let fixture_messages: Vec<&Map<String, Value>> = fixture
        .entries
        .iter()
        .filter(|entry| entry.get("type") == Some(&Value::String("message".into())))
        .collect();
    let reference_entry = fixture_messages.first().copied().unwrap_or_else(|| {
        panic!("pi-session-structure fixture carries no message entries");
    });
    // TS casts `message` then checks `content` — non-object message yields the
    // same "has no content blocks" path (no invented "is not an object" error).
    let reference_blocks = reference_entry
        .get("message")
        .and_then(Value::as_object)
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .filter(|blocks| !blocks.is_empty())
        .unwrap_or_else(|| panic!("pi-session-structure fixture message has no content blocks"));
    let reference_text_block = reference_blocks
        .iter()
        .find_map(|block| {
            let obj = block.as_object()?;
            if obj.get("type") == Some(&Value::String("text".into())) {
                Some(obj)
            } else {
                None
            }
        })
        .unwrap_or_else(|| panic!("pi-session-structure fixture message has no text block"));

    let mut seen_ids: BTreeSet<String> = BTreeSet::new();
    let mut previous_id: Option<String> = None;
    for (i, entry) in file.entries.iter().enumerate() {
        let where_ = format!("entry[{i}]");
        if entry.get("type") != Some(&Value::String("message".into())) {
            fail(&format!("{where_}.type"), "\"message\"", entry.get("type"));
        }
        if key_set(entry) != key_set(reference_entry) {
            fail(
                &format!("{where_} keys"),
                &key_set(reference_entry),
                Some(&Value::String(key_set(entry))),
            );
        }
        let entry_id = match entry.get("id") {
            Some(Value::String(s)) if !s.is_empty() => s.clone(),
            other => fail(&format!("{where_}.id"), "a non-empty string", other),
        };
        match entry.get("timestamp") {
            Some(Value::String(s)) if !s.is_empty() => {}
            other => fail(&format!("{where_}.timestamp"), "a non-empty string", other),
        }
        let expected_parent = match &previous_id {
            None => Value::Null,
            Some(id) => Value::String(id.clone()),
        };
        if entry.get("parentId") != Some(&expected_parent) {
            fail(
                &format!("{where_}.parentId (chain)"),
                &js_json_stringify(&expected_parent),
                entry.get("parentId"),
            );
        }
        if seen_ids.contains(&entry_id) {
            fail(
                &format!("{where_}.id"),
                "a unique id",
                Some(&Value::String(entry_id.clone())),
            );
        }
        seen_ids.insert(entry_id.clone());
        previous_id = Some(entry_id);

        // TS: typeof message !== "object" || message === null.
        // Arrays pass (`typeof [] === "object"`) and fail later on role/keys —
        // do not invent an earlier "an object" error for arrays.
        // Missing key → undefined (not null).
        let message_obj: Option<&Map<String, Value>> = match entry.get("message") {
            Some(Value::Object(m)) => Some(m),
            Some(Value::Array(_)) => None, // object-like; no string keys
            Some(Value::Null) => fail(
                &format!("{where_}.message"),
                "an object",
                Some(&Value::Null),
            ),
            Some(other) => fail(&format!("{where_}.message"), "an object", Some(other)),
            None => fail(&format!("{where_}.message"), "an object", None),
        };
        let role = message_obj.and_then(|m| m.get("role"));
        match role {
            Some(Value::String(s)) if !s.is_empty() => {}
            other => fail(
                &format!("{where_}.message.role"),
                "a non-empty string",
                other,
            ),
        }
        let content = match message_obj.and_then(|m| m.get("content")) {
            Some(Value::Array(arr)) if !arr.is_empty() => arr,
            other => fail(
                &format!("{where_}.message.content"),
                "a non-empty block array",
                other,
            ),
        };
        for (j, block) in content.iter().enumerate() {
            // TS: typeof block !== "object" || block === null — arrays pass
            // (`typeof [] === "object"`) and reach the key-set check with
            // `Object.keys(array)` → `"0,1,…"`.
            let b: Option<&Map<String, Value>> = match block {
                Value::Object(obj) => Some(obj),
                Value::Array(_) => None,
                Value::Null => fail(
                    &format!("{where_}.message.content[{j}]"),
                    "an object",
                    Some(&Value::Null),
                ),
                other => fail(
                    &format!("{where_}.message.content[{j}]"),
                    "an object",
                    Some(other),
                ),
            };
            let block_keys = match block {
                Value::Object(obj) => key_set(obj),
                Value::Array(arr) => js_array_key_set(arr.len()),
                _ => unreachable!("non-object non-array already failed above"),
            };
            if block_keys != key_set(reference_text_block) {
                fail(
                    &format!("{where_}.message.content[{j}] keys"),
                    &key_set(reference_text_block),
                    Some(&Value::String(block_keys)),
                );
            }
            let b = b.expect("keys matched only for objects with reference key set");
            if b.get("type") != Some(&Value::String("text".into())) {
                fail(
                    &format!("{where_}.message.content[{j}].type"),
                    "\"text\"",
                    b.get("type"),
                );
            }
            if !matches!(b.get("text"), Some(Value::String(_))) {
                fail(
                    &format!("{where_}.message.content[{j}].text"),
                    "a string",
                    b.get("text"),
                );
            }
        }
    }
}
