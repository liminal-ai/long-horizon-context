//! Ported from packages/lhc/src/threads/index.ts. Phase 1 skeleton.
//!
//! Wave 0: closed `ThreadRef` Deserialize. Wave 1: `new_thread` (+ types).
//! Wave 3 Phase 1: full public surface + private helpers as skeletons —
//! types/constants REAL; every behavior body is `todo!("phase 2")`.
//!
//! LAYERING: import shared_tech *submodules* only. `info` must not take a
//! package-level shared_tech import that deadlocks the persist↔threads cycle
//! (Python imports persist inside `info`; Phase 2 follows that pattern).

pub mod internal;

use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

use crate::shared_tech::errors::OpResult;

#[allow(unused_imports)] // Phase 2: new_thread / resolve wiring
use internal::create::{create_thread_file, delete_thread_file, generate_thread_id};
#[allow(unused_imports)] // Phase 2: registry path / row helpers
use internal::registry::{
    RegistryRow, SelectAllThreadRowsOpts, insert_thread_row, open_registry_for_read,
    open_registry_for_write, resolve_registry_path, select_all_thread_rows, select_thread_row,
    select_thread_rows_by_prefix,
};

/// TS `{ threadId; registryPath? }` arm.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRefId {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry_path: Option<String>,
}

/// TS `{ filePath }` arm.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRefFile {
    pub file_path: String,
}

/// TS `ThreadRef = { threadId; registryPath? } | { filePath }`.
///
/// Closed wire shape: custom `Deserialize` rejects unknown fields with
/// serde's `unknown_field` error (names the bad key). TS's
/// `{ filePath, surprise: true } as unknown as ThreadRef` is represented by
/// that serde-boundary rejection — public API remains this typed enum, not a
/// second wire entrypoint.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ThreadRef {
    Id(ThreadRefId),
    File(ThreadRefFile),
}

impl ThreadRef {
    pub fn file_path(path: impl Into<String>) -> Self {
        ThreadRef::File(ThreadRefFile {
            file_path: path.into(),
        })
    }
}

impl<'de> Deserialize<'de> for ThreadRef {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ThreadRefVisitor;

        impl<'de> Visitor<'de> for ThreadRefVisitor {
            type Value = ThreadRef;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("ThreadRef object ({ filePath } | { threadId, registryPath? })")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut file_path: Option<String> = None;
                let mut thread_id: Option<String> = None;
                let mut registry_path: Option<String> = None;

                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "filePath" => {
                            if file_path.is_some() {
                                return Err(de::Error::duplicate_field("filePath"));
                            }
                            file_path = Some(map.next_value()?);
                        }
                        "threadId" => {
                            if thread_id.is_some() {
                                return Err(de::Error::duplicate_field("threadId"));
                            }
                            thread_id = Some(map.next_value()?);
                        }
                        "registryPath" => {
                            if registry_path.is_some() {
                                return Err(de::Error::duplicate_field("registryPath"));
                            }
                            registry_path = Some(map.next_value()?);
                        }
                        other => {
                            return Err(de::Error::unknown_field(
                                other,
                                &["filePath", "threadId", "registryPath"],
                            ));
                        }
                    }
                }

                match (file_path, thread_id, registry_path) {
                    (Some(file_path), None, None) => {
                        Ok(ThreadRef::File(ThreadRefFile { file_path }))
                    }
                    (None, Some(thread_id), registry_path) => Ok(ThreadRef::Id(ThreadRefId {
                        thread_id,
                        registry_path,
                    })),
                    (Some(_), Some(_), _) => Err(de::Error::custom(
                        "ThreadRef must be either { filePath } or { threadId }, not both",
                    )),
                    (None, None, _) => {
                        Err(de::Error::custom("ThreadRef requires filePath or threadId"))
                    }
                    (Some(_), None, Some(_)) => {
                        Err(de::Error::unknown_field("registryPath", &["filePath"]))
                    }
                }
            }
        }

        deserializer.deserialize_map(ThreadRefVisitor)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewThreadInput {
    pub file_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveInput {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry_path: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListThreadsInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub thread_id: String,
    pub file_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// ISO-8601
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewThreadResult {
    pub thread_id: String,
    pub file_path: String,
}

/// TS `ThreadFileInfo` — identity header from `thread_metadata`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadFileInfo {
    pub thread_id: String,
    pub created_at: String,
}

/// TS `resolveThreadRef` success payload `{ filePath }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedThreadPath {
    pub file_path: String,
}

fn to_thread_info(_row: &RegistryRow) -> ThreadInfo {
    todo!("phase 2")
}

fn thread_not_found<T>(_thread_id: &str) -> OpResult<T> {
    todo!("phase 2")
}

fn ambiguous_thread_id<T>(_prefix: &str, _match_ids: &[String]) -> OpResult<T> {
    todo!("phase 2")
}

fn invalid_thread_ref<T>(_reason: &str) -> OpResult<T> {
    todo!("phase 2")
}

fn is_blank_path(_file_path: &str) -> bool {
    todo!("phase 2")
}

fn detail(_cause: &dyn std::fmt::Display) -> String {
    todo!("phase 2")
}

/// TS `openThreadDatabase` re-export — opening through the threads domain
/// guarantees schema is current before any write or read touches it.
pub use internal::create::open_thread_database;

/// TS `newThread`.
pub async fn new_thread(_input: NewThreadInput) -> OpResult<NewThreadResult> {
    todo!("phase 2")
}

/// TS `resolve` — full or partial (prefix) thread id (A-8).
pub async fn resolve(_input: ResolveInput) -> OpResult<ThreadInfo> {
    todo!("phase 2")
}

/// TS `listThreads`.
pub async fn list_threads(_input: Option<ListThreadsInput>) -> OpResult<Vec<ThreadInfo>> {
    todo!("phase 2")
}

/// TS `info` — pure read of thread_metadata under touch suppression.
///
/// Phase 2 imports `create_db_read_transaction` inside the body to preserve
/// the sanctioned persist ↔ threads cycle (see Python `threads/__init__.py`).
pub async fn info(_ref: ThreadRef) -> OpResult<ThreadFileInfo> {
    todo!("phase 2")
}

/// TS `resolveThreadRef` — single interpreter of thread references.
pub async fn resolve_thread_ref(_ref: ThreadRef) -> OpResult<ResolvedThreadPath> {
    todo!("phase 2")
}
