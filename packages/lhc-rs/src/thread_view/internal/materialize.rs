//! Ported from packages/lhc/src/thread-view/internal/materialize.ts.
//!
//! PI session JSONL writer: the pure mapping from assembled entries to the
//! pinned PI session file format, plus the file write. This module never sees a
//! database handle; it renders what the serving assembly hands it, keeping
//! materialize/model-context parity structural.
//!
//! Format pin from repo-ref/pi/packages/coding-agent/src/core/session-manager.ts:
//! JSONL. Line 1 is the header `{ type: "session", version, id, timestamp,
//! cwd }`; each subsequent line is `{ type: "message", id, parentId, timestamp,
//! message: { role, content } }` with parentId chaining each entry to the
//! previous. Content is encoded as PI text blocks: user content may be a bare
//! string in PI, but assistant content must be a block array, so both roles use
//! the one block encoding.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::render::AssembledContextMessage;
use crate::shared_tech::js_json::js_json_stringify;

/// CURRENT_SESSION_VERSION at the pin (PI coding agent 0.79.1) — see
/// test/fixtures/pi-session-structure.provenance.md.
pub const PI_SESSION_VERSION: i64 = 3;

/// One assembled entry with the metadata the file's generated fields derive from:
/// the entry id (message id for tail entries, viewId-band for band entries)
/// and the record-time timestamp (event recorded_at for tail entries, view
/// created-at for band entries). Never a write-time clock anywhere.
#[derive(Debug, Clone, PartialEq)]
pub struct MaterializeEntry {
    pub message: AssembledContextMessage,
    pub entry_id: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MaterializeInput {
    pub thread_id: String,
    /// The view's created-at, or the thread's created-at when never compacted
    /// (viewId null; the tail-only file still carries a valid header).
    pub header_timestamp: String,
    pub cwd: String,
    pub entries: Vec<MaterializeEntry>,
}

/// TS `writePiSessionFile` / `materialize` value `{ writtenPath: string }`.
/// One canonical type — re-exported from `thread_view` (not duplicated).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializeResult {
    pub written_path: String,
}

/// Lexical absolute resolution like Node `path.resolve` on POSIX hosts.
///
/// Joins against the process cwd when the input is relative, then collapses
/// `.` / `..` / repeated separators lexically. Does **not** touch the
/// filesystem — no `canonicalize`, no symlink dereference (`fs.realpath`).
pub(crate) fn path_resolve(path: &str) -> PathBuf {
    // Node `path.resolve` reads `process.cwd()` — a cwd failure must surface,
    // never silently rewrite a relative path as if rooted at `/`.
    let cwd = std::env::current_dir().unwrap_or_else(|err| panic!("{err}"));
    lexical_path_resolve(&cwd, path)
}

/// Pure lexical resolve (Node `path.resolve` collapse of `.` / `..`).
fn lexical_path_resolve(cwd: &Path, path: &str) -> PathBuf {
    // Node `path.resolve()` / `path.resolve('')` → cwd.
    let joined = if path.is_empty() {
        cwd.to_path_buf()
    } else if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        cwd.join(path)
    };
    lexical_normalize(&joined)
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    let mut absolute = false;
    for component in path.components() {
        match component {
            std::path::Component::Prefix(prefix) => {
                out.push(prefix.as_os_str());
            }
            std::path::Component::RootDir => {
                out.push(component.as_os_str());
                absolute = true;
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if let Some(last) = out.components().next_back() {
                    match last {
                        std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                            // Root saturation — Node keeps `/` under `/../`.
                        }
                        std::path::Component::ParentDir => out.push(".."),
                        // CurDir is never pushed; Normal is the only poppable tip.
                        std::path::Component::CurDir | std::path::Component::Normal(_) => {
                            out.pop();
                        }
                    }
                } else if !absolute {
                    out.push("..");
                }
            }
            std::path::Component::Normal(part) => out.push(part),
        }
    }
    if out.as_os_str().is_empty() {
        if absolute {
            PathBuf::from("/")
        } else {
            PathBuf::from(".")
        }
    } else {
        out
    }
}

fn text_block(text: &str) -> Value {
    let mut block = Map::new();
    block.insert("type".into(), Value::String("text".into()));
    block.insert("text".into(), Value::String(text.to_string()));
    Value::Object(block)
}

pub fn render_pi_session_lines(input: &MaterializeInput) -> Vec<String> {
    let mut header = Map::new();
    header.insert("type".into(), Value::String("session".into()));
    header.insert("version".into(), Value::Number(PI_SESSION_VERSION.into()));
    header.insert(
        "id".into(),
        Value::String(format!("{}:{}", input.thread_id, input.header_timestamp)),
    );
    header.insert(
        "timestamp".into(),
        Value::String(input.header_timestamp.clone()),
    );
    header.insert("cwd".into(), Value::String(input.cwd.clone()));

    let mut lines = vec![js_json_stringify(&Value::Object(header))];
    let mut parent_id: Option<String> = None;
    for entry in &input.entries {
        let mut message = Map::new();
        message.insert(
            "role".into(),
            Value::String(entry.message.role.as_str().to_string()),
        );
        message.insert(
            "content".into(),
            Value::Array(vec![text_block(&entry.message.content)]),
        );

        let mut line = Map::new();
        line.insert("type".into(), Value::String("message".into()));
        line.insert("id".into(), Value::String(entry.entry_id.clone()));
        line.insert(
            "parentId".into(),
            match &parent_id {
                None => Value::Null,
                Some(id) => Value::String(id.clone()),
            },
        );
        line.insert("timestamp".into(), Value::String(entry.timestamp.clone()));
        line.insert("message".into(), Value::Object(message));

        lines.push(js_json_stringify(&Value::Object(line)));
        parent_id = Some(entry.entry_id.clone());
    }
    lines
}

pub fn write_pi_session_file(input: &MaterializeInput, path: &str) -> MaterializeResult {
    let written_path = path_resolve(path);
    let written_path_str = written_path.to_string_lossy().into_owned();
    let body = format!("{}\n", render_pi_session_lines(input).join("\n"));
    // Propagate underlying filesystem errors (no invented wrapper wording).
    fs::write(&written_path, body).unwrap_or_else(|err| panic!("{err}"));
    MaterializeResult {
        written_path: written_path_str,
    }
}
