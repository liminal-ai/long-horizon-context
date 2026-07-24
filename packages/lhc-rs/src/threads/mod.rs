//! Ported from packages/lhc/src/threads/index.ts.

pub mod internal;

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

use crate::shared_tech::errors::{ErrorClass, ErrorCode, ErrorResult, OpResult, storage_failure};

use internal::create::{create_thread_file, delete_thread_file, generate_thread_id};
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
/// serde's `unknown_field` error (names the bad key).
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

fn to_thread_info(row: &RegistryRow) -> ThreadInfo {
    ThreadInfo {
        thread_id: row.thread_id.clone(),
        file_path: row.file_path.clone(),
        title: row.title.clone(),
        cwd: row.cwd.clone(),
        created_at: row.created_at.clone(),
    }
}

fn thread_not_found<T>(thread_id: &str) -> OpResult<T> {
    OpResult::Err {
        error: ErrorResult {
            error_class: ErrorClass::CallerError,
            code: ErrorCode::ThreadNotFound,
            reason: format!("no thread registered with id {thread_id}"),
            event_index: None,
        },
    }
}

fn ambiguous_thread_id<T>(prefix: &str, match_ids: &[String]) -> OpResult<T> {
    OpResult::Err {
        error: ErrorResult {
            error_class: ErrorClass::CallerError,
            code: ErrorCode::AmbiguousThreadId,
            reason: format!(
                "thread id \"{prefix}\" is ambiguous: it matches {} threads ({}); use a longer id",
                match_ids.len(),
                match_ids.join(", ")
            ),
            event_index: None,
        },
    }
}

fn invalid_thread_ref<T>(reason: &str) -> OpResult<T> {
    OpResult::Err {
        error: ErrorResult {
            error_class: ErrorClass::CallerError,
            code: ErrorCode::InvalidThreadRef,
            reason: reason.to_string(),
            event_index: None,
        },
    }
}

fn is_blank_path(file_path: &str) -> bool {
    file_path.trim().is_empty()
}

fn detail(cause: &dyn std::fmt::Display) -> String {
    cause.to_string()
}

fn panic_detail(panic: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = panic.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = panic.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".to_string()
    }
}

fn iso_now() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as i64;
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000) as u32;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let hh = tod / 3600;
    let mm = (tod % 3600) / 60;
    let ss = tod % 60;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }).div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let y = y + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

/// TS `openThreadDatabase` re-export — opening through the threads domain
/// guarantees schema is current before any write or read touches it.
pub use internal::create::open_thread_database;

/// TS `newThread`.
pub async fn new_thread(input: NewThreadInput) -> OpResult<NewThreadResult> {
    if is_blank_path(&input.file_path) {
        return invalid_thread_ref("filePath must be a non-empty path; received a blank string");
    }
    if Path::new(&input.file_path).exists() {
        return OpResult::Err {
            error: ErrorResult {
                error_class: ErrorClass::CallerError,
                code: ErrorCode::PathExists,
                reason: format!("a file already exists at {}", input.file_path),
                event_index: None,
            },
        };
    }

    let thread_id = generate_thread_id();
    let created_at = iso_now();

    let create = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        create_thread_file(&input.file_path, &thread_id, &created_at);
    }));
    if let Err(cause) = create {
        delete_thread_file(&input.file_path);
        return storage_failure(&format!(
            "thread file creation failed: {}",
            panic_detail(cause)
        ));
    }

    let registry_path = resolve_registry_path(input.registry_path.as_deref());
    let registry_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let registry = open_registry_for_write(&registry_path);
        let mut row = RegistryRow {
            thread_id: thread_id.clone(),
            file_path: input.file_path.clone(),
            title: None,
            cwd: None,
            created_at: created_at.clone(),
        };
        if input.title.is_some() {
            row.title = input.title.clone();
        }
        if input.cwd.is_some() {
            row.cwd = input.cwd.clone();
        }
        insert_thread_row(&registry, &row);
        registry.close();
    }));
    if let Err(cause) = registry_result {
        delete_thread_file(&input.file_path);
        return storage_failure(&format!("registry insert failed: {}", panic_detail(cause)));
    }

    OpResult::Ok {
        value: NewThreadResult {
            thread_id,
            file_path: input.file_path,
        },
    }
}

/// TS `resolve` — full or partial (prefix) thread id (A-8).
pub async fn resolve(input: ResolveInput) -> OpResult<ThreadInfo> {
    let registry_path = resolve_registry_path(input.registry_path.as_deref());
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let Some(registry) = open_registry_for_read(&registry_path) else {
            return thread_not_found(&input.thread_id);
        };
        if let Some(exact) = select_thread_row(&registry, &input.thread_id) {
            let info = to_thread_info(&exact);
            registry.close();
            return OpResult::Ok { value: info };
        }
        let matches = select_thread_rows_by_prefix(&registry, &input.thread_id);
        let out = if matches.len() == 1 {
            OpResult::Ok {
                value: to_thread_info(&matches[0]),
            }
        } else if matches.len() > 1 {
            let ids: Vec<String> = matches.iter().map(|m| m.thread_id.clone()).collect();
            ambiguous_thread_id(&input.thread_id, &ids)
        } else {
            thread_not_found(&input.thread_id)
        };
        registry.close();
        out
    }));
    match result {
        Ok(value) => value,
        Err(cause) => storage_failure(&format!("registry read failed: {}", panic_detail(cause))),
    }
}

/// TS `listThreads`.
pub async fn list_threads(input: Option<ListThreadsInput>) -> OpResult<Vec<ThreadInfo>> {
    let registry_path =
        resolve_registry_path(input.as_ref().and_then(|i| i.registry_path.as_deref()));
    let cwd = input.and_then(|i| i.cwd);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let Some(registry) = open_registry_for_read(&registry_path) else {
            return OpResult::Ok { value: vec![] };
        };
        let opts = SelectAllThreadRowsOpts { cwd };
        let rows = select_all_thread_rows(&registry, opts)
            .iter()
            .map(to_thread_info)
            .collect();
        registry.close();
        OpResult::Ok { value: rows }
    }));
    match result {
        Ok(value) => value,
        Err(cause) => storage_failure(&format!("registry read failed: {}", panic_detail(cause))),
    }
}

/// TS `info` — pure read of thread_metadata under touch suppression.
pub async fn info(ref_: ThreadRef) -> OpResult<ThreadFileInfo> {
    use crate::shared_tech::persist::create_db_read_transaction;

    let result = create_db_read_transaction(ref_, |transaction| {
        let file_path = transaction.file_path.clone();
        Box::pin(async move {
            let row = transaction
                .db
                .prepare("SELECT thread_id, created_at FROM thread_metadata WHERE id = 1")
                .get();
            match row {
                None => {
                    storage_failure(&format!("thread file at {file_path} lost its metadata row"))
                }
                Some(map) => {
                    let thread_id = map
                        .get("thread_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_else(|| panic!("thread_id column"))
                        .to_string();
                    let created_at = map
                        .get("created_at")
                        .and_then(|v| v.as_str())
                        .unwrap_or_else(|| panic!("created_at column"))
                        .to_string();
                    OpResult::Ok {
                        value: ThreadFileInfo {
                            thread_id,
                            created_at,
                        },
                    }
                }
            }
        })
    })
    .await;

    match result {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => OpResult::Err { error },
    }
}

/// TS `resolveThreadRef` — single interpreter of thread references.
pub async fn resolve_thread_ref(ref_: ThreadRef) -> OpResult<ResolvedThreadPath> {
    match ref_ {
        ThreadRef::Id(id) => {
            let resolved = resolve(ResolveInput {
                thread_id: id.thread_id,
                registry_path: id.registry_path,
            })
            .await;
            match resolved {
                OpResult::Ok { value } => OpResult::Ok {
                    value: ResolvedThreadPath {
                        file_path: value.file_path,
                    },
                },
                OpResult::Err { error } => OpResult::Err { error },
            }
        }
        ThreadRef::File(file) => {
            if is_blank_path(&file.file_path) {
                return invalid_thread_ref(
                    "filePath must be a non-empty path; received a blank string",
                );
            }
            OpResult::Ok {
                value: ResolvedThreadPath {
                    file_path: file.file_path,
                },
            }
        }
    }
}
