//! Ported from packages/lhc/src/messages/internal/smoothing.ts.
//!
//! Deterministic prompt floor for smoothing recovery. Pure by construction:
//! no DB, no clock, no inference.
//!
//! Regex dialect notes (JS → Rust):
//! - `\r\n?`, `[ \t\f\v]+`, ` *\n *`, `\n{3,}` — same as JS.
//! - `\bi\b` — JS `\b` is ASCII-word (`[A-Za-z0-9_]`); Rust `regex` `\b` is
//!   Unicode. Use `(?-u:\bi\b)` to match JS.
//! - `.trim()` / `.trimStart()` — use [`js_trim`] / [`js_trim_start`] (BOM in,
//!   NEL out); never Rust `str::trim*`.

use crate::shared_tech::js_json::{js_trim, js_trim_start};
use regex::Regex;
use std::sync::LazyLock;

static CLEAN_PROSE_CRLF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\r\n?").expect("CLEAN_PROSE_CRLF"));
static CLEAN_PROSE_HORIZONTAL_WS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[ \t\f\v]+").expect("CLEAN_PROSE_HORIZONTAL_WS"));
static CLEAN_PROSE_NEWLINE_SPACES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r" *\n *").expect("CLEAN_PROSE_NEWLINE_SPACES"));
static CLEAN_PROSE_MULTI_NEWLINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n{3,}").expect("CLEAN_PROSE_MULTI_NEWLINE"));
/// JS `/\bi\b/g` — ASCII word boundaries via `(?-u:\b)` (Rust `regex` `\b` is
/// Unicode by default; lookaround would require fancy-regex).
static CLEAN_PROSE_LOWERCASE_I: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\bi\b)").expect("CLEAN_PROSE_LOWERCASE_I"));

fn clean_prose(text: &str) -> String {
    let text = CLEAN_PROSE_CRLF.replace_all(text, "\n");
    let text = CLEAN_PROSE_HORIZONTAL_WS.replace_all(&text, " ");
    let text = CLEAN_PROSE_NEWLINE_SPACES.replace_all(&text, "\n");
    let text = CLEAN_PROSE_MULTI_NEWLINE.replace_all(&text, "\n\n");
    let text = js_trim(&text);
    CLEAN_PROSE_LOWERCASE_I.replace_all(text, "I").into_owned()
}

struct ReadLineResult {
    /// TS `raw` line including terminator — retained for shape fidelity.
    #[allow(dead_code)]
    raw: String,
    body: String,
    next: usize,
}

/// Slice by UTF-16 code units to match JS `string` indexing / `.length`.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn slice_utf16(s: &str, start: usize, end: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    let end = end.min(units.len());
    let start = start.min(end);
    String::from_utf16_lossy(&units[start..end])
}

fn read_line(text: &str, start: usize) -> ReadLineResult {
    let units: Vec<u16> = text.encode_utf16().collect();
    let len = units.len();
    let mut end = start;
    while end < len && units[end] != b'\n' as u16 && units[end] != b'\r' as u16 {
        end += 1;
    }
    let mut next = end;
    if end < len {
        if units[end] == b'\r' as u16 && end + 1 < len && units[end + 1] == b'\n' as u16 {
            next = end + 2;
        } else {
            next = end + 1;
        }
    }
    ReadLineResult {
        raw: slice_utf16(text, start, next),
        body: slice_utf16(text, start, end),
        next,
    }
}

/// TS fence marker: `` ` `` or `~`, else none.
fn fence_marker(body: &str) -> Option<&'static str> {
    let trimmed = js_trim_start(body);
    if trimmed.starts_with("```") {
        Some("`")
    } else if trimmed.starts_with("~~~") {
        Some("~")
    } else {
        None
    }
}

pub fn clean_prompt(text: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut prose_start = 0usize;
    let mut cursor = 0usize;
    let len = utf16_len(text);
    while cursor < len {
        let line = read_line(text, cursor);
        let marker = fence_marker(&line.body);
        if marker.is_none() {
            cursor = line.next;
            continue;
        }
        let marker = marker.unwrap();
        let prose = clean_prose(&slice_utf16(text, prose_start, cursor));
        if !prose.is_empty() {
            parts.push(format!("{prose}\n"));
        }

        let mut fence_end = line.next;
        while fence_end < len {
            let fence_line = read_line(text, fence_end);
            fence_end = fence_line.next;
            if fence_marker(&fence_line.body) == Some(marker) {
                break;
            }
        }
        parts.push(slice_utf16(text, cursor, fence_end));
        cursor = fence_end;
        prose_start = fence_end;
    }
    let tail = clean_prose(&slice_utf16(text, prose_start, len));
    if !tail.is_empty() {
        parts.push(tail);
    }
    parts.join("")
}
