//! Ported from packages/lhc/src/messages/internal/smoothing.ts. Phase 1 skeleton.
//!
//! Deterministic prompt floor for smoothing recovery. Regex/pattern literals
//! REAL (private — TS `cleanProse` module-local); behavior bodies
//! `todo!("phase 2")`.

/// TS `cleanProse` — `/\r\n?/g`
#[allow(dead_code)]
const CLEAN_PROSE_CRLF_PATTERN: &str = r"\r\n?";

/// TS `cleanProse` — `/[ \t\f\v]+/g`
#[allow(dead_code)]
const CLEAN_PROSE_HORIZONTAL_WS_PATTERN: &str = r"[ \t\f\v]+";

/// TS `cleanProse` — `/ *\n */g`
#[allow(dead_code)]
const CLEAN_PROSE_NEWLINE_SPACES_PATTERN: &str = r" *\n *";

/// TS `cleanProse` — `/\n{3,}/g`
#[allow(dead_code)]
const CLEAN_PROSE_MULTI_NEWLINE_PATTERN: &str = r"\n{3,}";

/// TS `cleanProse` — `/\bi\b/g` (JS `\b` is ASCII-word; Phase 2 matches JS).
#[allow(dead_code)]
const CLEAN_PROSE_LOWERCASE_I_PATTERN: &str = r"\bi\b";

fn clean_prose(_text: &str) -> String {
    todo!("phase 2")
}

struct ReadLineResult {
    raw: String,
    body: String,
    next: usize,
}

fn read_line(_text: &str, _start: usize) -> ReadLineResult {
    todo!("phase 2")
}

/// TS fence marker: `` ` `` or `~`, else none.
fn fence_marker(_body: &str) -> Option<&'static str> {
    todo!("phase 2")
}

pub fn clean_prompt(_text: &str) -> String {
    todo!("phase 2")
}
