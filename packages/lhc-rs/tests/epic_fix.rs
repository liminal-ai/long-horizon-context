//! Ported from packages/lhc/test/epic-fix.test.ts. Phase 1.
//!
//! Epic Fix Batch 1: blank-path rejection (F-EPIC-001), read-surface reference
//! validation (F-EPIC-002). New Green-phase suite — the Red-committed files
//! stay byte-identical.
//!
//! 9 semantic tests: 3 direct + 2 loop-generated cases × 3 read surfaces.

mod fixtures;

use fixtures::{TempStore, temp_store};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::threads::{ListThreadsInput, NewThreadInput, ThreadRef, ThreadRefId};
use lhc::{intake_stream, messages, threads, turns};

struct EpicFixCleanup {
    store: TempStore,
}

impl Drop for EpicFixCleanup {
    fn drop(&mut self) {
        self.store.cleanup();
    }
}

fn setup() -> EpicFixCleanup {
    EpicFixCleanup {
        store: temp_store(),
    }
}

// ── F-EPIC-001 ────────────────────────────────────────────────────

#[tokio::test]
async fn new_thread_empty_file_path_caller_error_nothing_created_no_registry_row() {
    let ctx = setup();
    let store = &ctx.store;

    let result = threads::new_thread(NewThreadInput {
        file_path: String::new(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await;
    assert!(!result.is_ok());
    let OpResult::Err { error } = result else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
    assert_eq!(error.code, ErrorCode::InvalidThreadRef);

    assert!(!store.registry_path.exists());
    let listed = threads::list_threads(Some(ListThreadsInput {
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    }))
    .await;
    assert!(listed.is_ok());
    if let OpResult::Ok { value } = listed {
        assert_eq!(value, Vec::<lhc::threads::ThreadInfo>::new());
    }
}

#[tokio::test]
async fn new_thread_with_a_whitespace_only_path_is_refused_the_same_way() {
    let ctx = setup();
    let store = &ctx.store;

    let result = threads::new_thread(NewThreadInput {
        file_path: "   ".into(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await;
    assert!(!result.is_ok());
    let OpResult::Err { error } = result else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
    assert_eq!(error.code, ErrorCode::InvalidThreadRef);
    assert!(!store.registry_path.exists());
}

#[tokio::test]
async fn resolve_thread_ref_empty_file_path_fails_closed_with_caller_error() {
    let _ctx = setup();

    let result = threads::resolve_thread_ref(ThreadRef::file_path("")).await;
    assert!(!result.is_ok());
    let OpResult::Err { error } = result else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
    assert_eq!(error.code, ErrorCode::InvalidThreadRef);
}

// ── F-EPIC-002 — empty path × 3 read surfaces ─────────────────────

#[tokio::test]
async fn intake_stream_list_events_empty_path_caller_error_no_storage_open() {
    let _ctx = setup();
    let result = intake_stream::list_events(ThreadRef::file_path("")).await;
    assert!(!result.is_ok());
    let OpResult::Err { error } = result else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
}

#[tokio::test]
async fn messages_list_empty_path_caller_error_no_storage_open() {
    let _ctx = setup();
    let result = messages::list(ThreadRef::file_path(""), None).await;
    assert!(!result.is_ok());
    let OpResult::Err { error } = result else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
}

#[tokio::test]
async fn turns_list_turns_empty_path_caller_error_no_storage_open() {
    let _ctx = setup();
    let result = turns::list_turns(ThreadRef::file_path("")).await;
    assert!(!result.is_ok());
    let OpResult::Err { error } = result else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
}

// ── F-EPIC-002 — unknown id × 3 read surfaces ─────────────────────

#[tokio::test]
async fn intake_stream_list_events_unknown_id_thread_not_found() {
    let ctx = setup();
    let store = &ctx.store;
    let result = intake_stream::list_events(ThreadRef::Id(ThreadRefId {
        thread_id: "th_unknown".into(),
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    }))
    .await;
    assert!(!result.is_ok());
    let OpResult::Err { error } = result else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
    assert_eq!(error.code, ErrorCode::ThreadNotFound);
}

#[tokio::test]
async fn messages_list_unknown_id_thread_not_found() {
    let ctx = setup();
    let store = &ctx.store;
    let result = messages::list(
        ThreadRef::Id(ThreadRefId {
            thread_id: "th_unknown".into(),
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        }),
        None,
    )
    .await;
    assert!(!result.is_ok());
    let OpResult::Err { error } = result else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
    assert_eq!(error.code, ErrorCode::ThreadNotFound);
}

#[tokio::test]
async fn turns_list_turns_unknown_id_thread_not_found() {
    let ctx = setup();
    let store = &ctx.store;
    let result = turns::list_turns(ThreadRef::Id(ThreadRefId {
        thread_id: "th_unknown".into(),
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    }))
    .await;
    assert!(!result.is_ok());
    let OpResult::Err { error } = result else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
    assert_eq!(error.code, ErrorCode::ThreadNotFound);
}
