//! Ported from packages/lhc/src/shared-tech/content-blocks.ts (TS `717a146`).
//!
//! Anthropic Messages API content blocks inside LHC. Every block type the API
//! defines is held faithfully; the only rewrite is that binary or opaque
//! payload strings (base64 image and PDF bytes, redacted-thinking data, web
//! search encrypted content) leave the JSON and live in the thread's blob
//! table, keyed by content hash. The block keeps the API's shape and names;
//! the payload field holds a reference `{ $blob, bytes }` in place of the
//! string. Text never carries base64: not in the event payload, not in a
//! message block, not in a band, not in a served view unless the caller asks
//! for the block back inlined.
//!
//! Pure module: no database. Callers extract blobs at intake and inline them
//! at serving through the two small functions here.
//!
//! Byte parity: rewritten blocks keep the source's insertion order with the
//! replaced key in place (JS object spread + same-key assignment; serde_json
//! `preserve_order` insert on an existing key keeps its slot). Hashes are
//! sha256 of the decoded bytes, matching Node `createHash("sha256")`.

use serde_json::{Map, Value};

use super::js_json::{js_json_stringify, js_string_nullish};
use super::sha256::sha256_hex_bytes;

/// Block type names, as the API spells them. Text-shaped types are stored as
/// JSON verbatim (no blob); blob-bearing types have their payload paths
/// extracted.
pub const API_BLOCK_TYPES: [&str; 17] = [
    "text",
    "image",
    "document",
    "tool_use",
    "tool_result",
    "thinking",
    "redacted_thinking",
    "server_tool_use",
    "web_search_tool_result",
    "web_fetch_tool_result",
    "code_execution_tool_result",
    "bash_code_execution_tool_result",
    "text_editor_code_execution_tool_result",
    "tool_search_tool_result",
    "search_result",
    "container_upload",
    "tool_reference",
];

/// TS `BlobRef` — `{ $blob: "sha256:<hex>", bytes }` (decoded byte length).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobRef {
    pub blob: String,
    pub bytes: i64,
}

impl BlobRef {
    /// The reference as JSON, keys in TS order (`$blob`, `bytes`).
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("$blob".into(), Value::String(self.blob.clone()));
        map.insert("bytes".into(), Value::Number(self.bytes.into()));
        Value::Object(map)
    }

    /// The bare hex digest (`sha256:` prefix removed when present).
    pub fn sha256_hex(&self) -> &str {
        self.blob.strip_prefix("sha256:").unwrap_or(&self.blob)
    }
}

/// TS `ExtractedBlob`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedBlob {
    pub sha256: String,
    pub media_type: Option<String>,
    pub data: Vec<u8>,
}

/// TS `ExtractResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct ExtractResult {
    pub blocks: Vec<Value>,
    pub blobs: Vec<ExtractedBlob>,
}

/// TS `BlobLoader = (sha256) => Uint8Array | undefined`.
pub type BlobLoader<'a> = &'a dyn Fn(&str) -> Option<Vec<u8>>;

pub fn is_plain_record(value: &Value) -> bool {
    value.is_object()
}

pub fn is_api_block(value: &Value) -> bool {
    match value.as_object().and_then(|o| o.get("type")) {
        Some(Value::String(t)) => API_BLOCK_TYPES.contains(&t.as_str()),
        _ => false,
    }
}

pub fn is_blob_ref(value: &Value) -> bool {
    match value.as_object() {
        Some(o) => {
            matches!(o.get("$blob"), Some(Value::String(_)))
                && matches!(o.get("bytes"), Some(Value::Number(_)))
        }
        None => false,
    }
}

/// Parse a `{ $blob, bytes }` value (see [`is_blob_ref`]).
pub fn blob_ref_of(value: &Value) -> Option<BlobRef> {
    let o = value.as_object()?;
    let blob = o.get("$blob")?.as_str()?.to_string();
    let bytes = match o.get("bytes")? {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .unwrap_or(0),
        _ => return None,
    };
    Some(BlobRef { blob, bytes })
}

fn blob_ref_for(data: &[u8]) -> (BlobRef, String) {
    let sha256 = sha256_hex_bytes(data);
    (
        BlobRef {
            blob: format!("sha256:{sha256}"),
            bytes: data.len() as i64,
        },
        sha256,
    )
}

// ── base64 (Node `Buffer` semantics) ─────────────────────────────

fn base64_value(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

/// `Buffer.from(text, "base64")`: lenient — both alphabets, characters
/// outside the alphabet skipped, padding optional, decoding stops at the
/// first `=`, a trailing partial group yields its whole bytes only.
pub fn base64_decode_node(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &c in text.as_bytes() {
        if c == b'=' {
            break;
        }
        let Some(v) = base64_value(c) else {
            continue;
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    out
}

/// `Buffer.from(bytes).toString("base64")`: standard alphabet, padded.
pub fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        let n = (u32::from(b0) << 16) | (u32::from(b1) << 8) | u32::from(b2);
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((n >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(n & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

// ── extraction (intake) ──────────────────────────────────────────

struct Sink {
    blobs: Vec<ExtractedBlob>,
}

/// A `{type:"base64", media_type, data}` source: data leaves as a blob. Other
/// source types (url, text, content) are text-shaped or nested.
fn extract_source(source: &Value, sink: &mut Sink) -> Value {
    let Some(src) = source.as_object() else {
        return source.clone();
    };
    if src.get("type").and_then(Value::as_str) == Some("base64")
        && let Some(Value::String(text)) = src.get("data")
    {
        let data = base64_decode_node(text);
        let (reference, sha256) = blob_ref_for(&data);
        sink.blobs.push(ExtractedBlob {
            sha256,
            media_type: src
                .get("media_type")
                .and_then(Value::as_str)
                .map(str::to_string),
            data,
        });
        let mut out = src.clone();
        out.insert("data".into(), reference.to_value());
        return Value::Object(out);
    }
    if src.get("type").and_then(Value::as_str) == Some("content")
        && let Some(Value::Array(items)) = src.get("content")
    {
        let mut out = src.clone();
        out.insert(
            "content".into(),
            Value::Array(
                items
                    .iter()
                    .map(|inner| extract_block(inner, sink))
                    .collect(),
            ),
        );
        return Value::Object(out);
    }
    source.clone()
}

fn extract_opaque(block: &Map<String, Value>, key: &str, sink: &mut Sink) -> Value {
    let Some(Value::String(text)) = block.get(key) else {
        return Value::Object(block.clone());
    };
    let data = text.as_bytes().to_vec();
    let (reference, sha256) = blob_ref_for(&data);
    sink.blobs.push(ExtractedBlob {
        sha256,
        media_type: None,
        data,
    });
    let mut out = block.clone();
    out.insert(key.to_string(), reference.to_value());
    Value::Object(out)
}

/// One block, blob payloads extracted, everything else verbatim. Unknown
/// shapes pass through untouched (a newer API type is still a record).
fn extract_block(value: &Value, sink: &mut Sink) -> Value {
    let Some(block) = value.as_object() else {
        return value.clone();
    };
    match block.get("type").and_then(Value::as_str) {
        Some("image") | Some("document") => {
            let mut out = block.clone();
            let source = block.get("source").cloned().unwrap_or(Value::Null);
            out.insert("source".into(), extract_source(&source, sink));
            Value::Object(out)
        }
        Some("redacted_thinking") => extract_opaque(block, "data", sink),
        Some("tool_result") => match block.get("content") {
            Some(Value::Array(items)) => {
                let mut out = block.clone();
                out.insert(
                    "content".into(),
                    Value::Array(
                        items
                            .iter()
                            .map(|inner| extract_block(inner, sink))
                            .collect(),
                    ),
                );
                Value::Object(out)
            }
            _ => value.clone(),
        },
        Some("web_search_tool_result") => match block.get("content") {
            Some(Value::Array(items)) => {
                let mut out = block.clone();
                out.insert(
                    "content".into(),
                    Value::Array(
                        items
                            .iter()
                            .map(|inner| match inner.as_object() {
                                Some(o)
                                    if o.get("type").and_then(Value::as_str)
                                        == Some("web_search_result") =>
                                {
                                    extract_opaque(o, "encrypted_content", sink)
                                }
                                _ => inner.clone(),
                            })
                            .collect(),
                    ),
                );
                Value::Object(out)
            }
            _ => value.clone(),
        },
        Some("web_fetch_tool_result") => {
            // content is a web_fetch block whose `content` is a document block.
            match block.get("content").and_then(Value::as_object) {
                Some(fetch) if fetch.get("content").is_some_and(Value::is_object) => {
                    let mut inner_out = fetch.clone();
                    let doc = fetch.get("content").cloned().unwrap_or(Value::Null);
                    inner_out.insert("content".into(), extract_block(&doc, sink));
                    let mut out = block.clone();
                    out.insert("content".into(), Value::Object(inner_out));
                    Value::Object(out)
                }
                _ => value.clone(),
            }
        }
        _ => value.clone(),
    }
}

/// Blocks with their binary/opaque payloads replaced by blob references.
pub fn extract_blobs(blocks: &[Value]) -> ExtractResult {
    let mut sink = Sink { blobs: Vec::new() };
    let out = blocks
        .iter()
        .map(|block| extract_block(block, &mut sink))
        .collect();
    ExtractResult {
        blocks: out,
        blobs: sink.blobs,
    }
}

// ── inlining (serving) ───────────────────────────────────────────

#[derive(Clone, Copy)]
enum InlineEncoding {
    Base64,
    Utf8,
}

fn inline_value(value: &Value, load: BlobLoader<'_>, encoding: InlineEncoding) -> Value {
    if let Some(reference) = blob_ref_of(value) {
        let Some(data) = load(reference.sha256_hex()) else {
            return value.clone();
        };
        return Value::String(match encoding {
            InlineEncoding::Base64 => base64_encode(&data),
            InlineEncoding::Utf8 => String::from_utf8_lossy(&data).into_owned(),
        });
    }
    value.clone()
}

/// The block as the API shaped it, blob payloads back in place. A blob that
/// is missing from the store leaves its reference in place rather than
/// inventing bytes.
pub fn inline_blobs(block: &Value, load: BlobLoader<'_>) -> Value {
    match block {
        Value::Array(items) => Value::Array(items.iter().map(|b| inline_blobs(b, load)).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, value) in map {
                if is_blob_ref(value) {
                    // base64 sources come back as base64; opaque strings (redacted thinking
                    // data, encrypted search content) were stored as their utf8 bytes.
                    let encoding = if key == "data"
                        && map.get("type").and_then(Value::as_str) == Some("base64")
                    {
                        InlineEncoding::Base64
                    } else {
                        InlineEncoding::Utf8
                    };
                    out.insert(key.clone(), inline_value(value, load, encoding));
                } else if value.is_object() || value.is_array() {
                    out.insert(key.clone(), inline_blobs(value, load));
                } else {
                    out.insert(key.clone(), value.clone());
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

// ── text-shaped rendering (bands, derivations, retrieval) ────────

/// JS `Number.prototype.toFixed(digits)` for the finite, non-negative values
/// this module formats: nearest, ties toward the larger value.
fn js_to_fixed(x: f64, digits: u32) -> String {
    let scale = 10f64.powi(digits as i32);
    let scaled = x * scale;
    let floor = scaled.floor();
    let n = if scaled - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    };
    if digits == 0 {
        return format!("{}", n as i64);
    }
    let whole = (n / scale).floor() as i64;
    let frac = (n as i64) - whole * (scale as i64);
    format!("{whole}.{frac:0width$}", width = digits as usize)
}

fn format_bytes(bytes: i64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    if bytes < 1024 * 1024 {
        return format!("{} KB", js_to_fixed(bytes as f64 / 1024.0, 0));
    }
    format!("{} MB", js_to_fixed(bytes as f64 / (1024.0 * 1024.0), 1))
}

fn source_description(source: &Value) -> String {
    let Some(src) = source.as_object() else {
        return String::new();
    };
    let media_type = src.get("media_type").and_then(Value::as_str);
    let data = src.get("data");
    let source_type = src.get("type").and_then(Value::as_str);
    let joined = |size: String| -> String {
        // `[mediaType, size].filter(Boolean).join(" · ")`.
        let mut parts: Vec<String> = Vec::new();
        if let Some(mt) = media_type
            && !mt.is_empty()
        {
            parts.push(mt.to_string());
        }
        if !size.is_empty() {
            parts.push(size);
        }
        parts.join(" · ")
    };
    if source_type == Some("base64")
        && let Some(reference) = data.and_then(blob_ref_of)
    {
        return joined(format_bytes(reference.bytes));
    }
    if source_type == Some("base64")
        && let Some(Value::String(text)) = data
    {
        // JS string length is UTF-16 code units; base64 text is ASCII.
        let len = text.encode_utf16().count() as i64;
        return joined(format_bytes(len * 3 / 4));
    }
    if source_type == Some("url")
        && let Some(Value::String(url)) = src.get("url")
    {
        return url.clone();
    }
    if source_type == Some("text") {
        return "text/plain".to_string();
    }
    if source_type == Some("content") {
        return "content".to_string();
    }
    String::new()
}

/// What the model needs to know that the block existed, not its content: the
/// API type, media type, size, and a title when the block has one. Text-shaped
/// blocks render their text. Tool-result nesting renders each inner block.
pub fn placeholder_text(block: &Value) -> String {
    let Some(b) = block.as_object() else {
        return String::new();
    };
    let str_field = |key: &str| -> Option<&str> { b.get(key).and_then(Value::as_str) };
    match b.get("type").and_then(Value::as_str) {
        Some("text") => str_field("text").unwrap_or("").to_string(),
        Some("image") => format!(
            "[image · {}]",
            source_description(b.get("source").unwrap_or(&Value::Null))
        ),
        Some("document") => {
            let title = match str_field("title") {
                Some(t) if !t.is_empty() => format!(" · {t}"),
                _ => String::new(),
            };
            let source = b.get("source").unwrap_or(&Value::Null);
            if let Some(src) = source.as_object()
                && src.get("type").and_then(Value::as_str) == Some("text")
                && let Some(Value::String(data)) = src.get("data")
            {
                return data.clone();
            }
            format!("[document · {}{title}]", source_description(source))
        }
        Some("redacted_thinking") => "[redacted thinking]".to_string(),
        Some("search_result") => {
            let title = str_field("title").unwrap_or("");
            let source = str_field("source").unwrap_or("");
            let inner = match b.get("content") {
                Some(Value::Array(items)) => items
                    .iter()
                    .map(placeholder_text)
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => String::new(),
            };
            format!("[search result · {title} · {source}]\n{inner}")
        }
        Some("tool_reference") => format!(
            "[tool reference · {}]",
            js_string_nullish(b.get("tool_name"))
        ),
        Some("container_upload") => format!(
            "[container upload · {}]",
            js_string_nullish(b.get("file_id"))
        ),
        Some("server_tool_use") => {
            let input = match b.get("input") {
                Some(Value::Null) | None => Value::Object(Map::new()),
                Some(other) => other.clone(),
            };
            format!(
                "[server tool use · {}] {}",
                js_string_nullish(b.get("name")),
                js_json_stringify(&input)
            )
        }
        Some("web_search_tool_result") => match b.get("content") {
            Some(Value::Array(items)) => {
                let lines: Vec<String> = items
                    .iter()
                    .map(|r| match r.as_object() {
                        Some(o) => format!(
                            "- {} {}",
                            js_string_nullish(o.get("title")),
                            js_string_nullish(o.get("url"))
                        )
                        .trim()
                        .to_string(),
                        None => String::new(),
                    })
                    .collect();
                format!(
                    "[web search result · {} result(s)]\n{}",
                    items.len(),
                    lines.join("\n")
                )
            }
            other => {
                let content = match other {
                    Some(Value::Null) | None => Value::Object(Map::new()),
                    Some(v) => v.clone(),
                };
                format!("[web search result] {}", js_json_stringify(&content))
            }
        },
        Some("web_fetch_tool_result") => {
            let content = b.get("content").and_then(Value::as_object);
            let url = content
                .and_then(|c| c.get("url"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let doc = match content.and_then(|c| c.get("content")) {
                Some(inner) => placeholder_text(inner),
                None => match content {
                    // `placeholderText(undefined)` → "".
                    Some(_) | None => String::new(),
                },
            };
            format!("[web fetch result · {url}]\n{doc}")
        }
        Some("tool_result") => match b.get("content") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(items)) => items
                .iter()
                .map(placeholder_text)
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        },
        // code_execution_tool_result and friends are text-shaped JSON; anything
        // newer is at least made visible.
        _ => js_json_stringify(block),
    }
}

/// True when the block carries (or carried) a blob payload.
pub fn has_blob_payload(block: &Value) -> bool {
    match block {
        Value::Array(items) => items.iter().any(has_blob_payload),
        Value::Object(map) => map
            .values()
            .any(|value| is_blob_ref(value) || has_blob_payload(value)),
        _ => false,
    }
}

/// Rough context cost of a block the text estimator cannot see. Images: the
/// API's ceiling for one image (~1,600 tokens at 1568px); PDFs: ~2,000 tokens
/// per page at ~50 KB a page, floor one page. Measured, not calibrated.
pub fn blob_token_estimate(block: &Value) -> i64 {
    let Some(b) = block.as_object() else {
        return 0;
    };
    let bytes = b
        .get("source")
        .and_then(Value::as_object)
        .and_then(|src| src.get("data"))
        .and_then(blob_ref_of)
        .map(|r| r.bytes)
        .unwrap_or(0);
    match b.get("type").and_then(Value::as_str) {
        Some("image") => 1_600,
        Some("document") => {
            if bytes > 0 {
                // Math.max(1, Math.ceil(bytes / 50_000)) * 2_000
                std::cmp::max(1, (bytes + 49_999) / 50_000) * 2_000
            } else {
                0
            }
        }
        Some("tool_result") => match b.get("content") {
            Some(Value::Array(items)) => items.iter().map(blob_token_estimate).sum(),
            _ => 0,
        },
        Some("web_fetch_tool_result") => match b.get("content").and_then(Value::as_object) {
            Some(content) => content.get("content").map(blob_token_estimate).unwrap_or(0),
            None => 0,
        },
        _ => 0,
    }
}
