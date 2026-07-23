//! Ported from packages/lhc/src/threads/index.ts. Phase 1 skeleton.
//!
//! Wave 0: ThreadRef. Wave 1 PARTIAL: `new_thread` (+ types) that Wave 1
//! tests call. Full threads surface lands in a later wave — do not expand
//! without that wave.
//!
//! Deleted Wave 1 invents: `ThreadInfo` / `ThreadFileInfo` — not required by
//! Wave 1 suites (later-wave registry/info surfaces).

pub mod internal;

use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

use crate::shared_tech::errors::OpResult;

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
pub struct NewThreadResult {
    pub thread_id: String,
    pub file_path: String,
}

/// TS `openThreadDatabase` re-export — PARTIAL.
pub use internal::create::open_thread_database;

/// TS `newThread` — PARTIAL stub (Wave 1 tests call it).
pub async fn new_thread(_input: NewThreadInput) -> OpResult<NewThreadResult> {
    todo!("phase 2")
}
