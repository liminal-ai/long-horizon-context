//! Ported from packages/lhc/test/threads-a8.test.ts. Phase 1.
//!
//! A-8 registry additions: cwd column, partial-id resolve with ambiguity
//! failure, cwd-scoped listing, and deterministic most-recent ordering.

mod fixtures;

use fixtures::temp_store;
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::threads;
use lhc::threads::{ListThreadsInput, NewThreadInput, ResolveInput};

fn path_str(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

async fn create(store: &fixtures::TempStore, title: Option<&str>, cwd: Option<&str>) -> String {
    let result = threads::new_thread(NewThreadInput {
        file_path: path_str(&store.thread_path(None)),
        title: title.map(str::to_string),
        cwd: cwd.map(str::to_string),
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    match result {
        OpResult::Ok { value } => value.thread_id,
        OpResult::Err { error } => panic!("create failed: {}", error.reason),
    }
}

#[tokio::test]
async fn new_thread_stores_cwd_resolve_and_list_threads_carry_it_back() {
    let store = temp_store();
    let id = create(&store, Some("a"), Some("/work/project-a")).await;

    let resolved = threads::resolve(ResolveInput {
        thread_id: id,
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    assert!(resolved.is_ok());
    if let OpResult::Ok { value } = &resolved {
        assert_eq!(value.cwd.as_deref(), Some("/work/project-a"));
    }

    let listed = threads::list_threads(Some(ListThreadsInput {
        cwd: None,
        registry_path: Some(path_str(&store.registry_path)),
    }))
    .await;
    assert!(listed.is_ok());
    if let OpResult::Ok { value } = listed {
        assert_eq!(value[0].cwd.as_deref(), Some("/work/project-a"));
    }
    store.cleanup();
}

#[tokio::test]
async fn a_thread_created_with_no_cwd_reports_cwd_undefined() {
    let store = temp_store();
    let id = create(&store, Some("no-cwd"), None).await;
    let resolved = threads::resolve(ResolveInput {
        thread_id: id,
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    assert!(resolved.is_ok());
    if let OpResult::Ok { value } = resolved {
        assert!(value.cwd.is_none());
    }
    store.cleanup();
}

#[tokio::test]
async fn resolves_a_unique_prefix_to_the_one_matching_thread() {
    let store = temp_store();
    let id = create(&store, Some("only"), None).await;
    let prefix = &id[..8]; // a true partial: shorter than the full id
    assert!(prefix.len() < id.len());

    let resolved = threads::resolve(ResolveInput {
        thread_id: prefix.to_string(),
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    assert!(resolved.is_ok());
    if let OpResult::Ok { value } = resolved {
        assert_eq!(value.thread_id, id);
    }
    store.cleanup();
}

#[tokio::test]
async fn a_full_id_still_resolves_exactly_exact_match_path() {
    let store = temp_store();
    let id = create(&store, None, None).await;
    let resolved = threads::resolve(ResolveInput {
        thread_id: id.clone(),
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    assert!(resolved.is_ok());
    if let OpResult::Ok { value } = resolved {
        assert_eq!(value.thread_id, id);
    }
    store.cleanup();
}

#[tokio::test]
async fn an_ambiguous_prefix_fails_ambiguous_thread_id_and_creates_nothing() {
    let store = temp_store();
    let a = create(&store, None, None).await;
    let b = create(&store, None, None).await;
    // Every id shares the "th_" scheme prefix, so it matches both threads.
    let ambiguous = threads::resolve(ResolveInput {
        thread_id: "th_".into(),
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    assert!(!ambiguous.is_ok());
    if let OpResult::Err { error } = &ambiguous {
        assert_eq!(error.code, ErrorCode::AmbiguousThreadId);
        assert_eq!(error.error_class, ErrorClass::CallerError);
        assert!(error.reason.contains(&a));
        assert!(error.reason.contains(&b));
    }

    // No thread was created by the failed resolution.
    let listed = threads::list_threads(Some(ListThreadsInput {
        cwd: None,
        registry_path: Some(path_str(&store.registry_path)),
    }))
    .await;
    assert!(listed.is_ok());
    if let OpResult::Ok { value } = listed {
        assert_eq!(value.len(), 2);
    }
    store.cleanup();
}

#[tokio::test]
async fn an_unresolvable_id_fails_thread_not_found_never_a_silent_match() {
    let store = temp_store();
    let _ = create(&store, None, None).await;
    let missing = threads::resolve(ResolveInput {
        thread_id: "th_zzzzzzzzzzzzzzzz".into(), // 'z' is not in the hex id alphabet
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    assert!(!missing.is_ok());
    if let OpResult::Err { error } = missing {
        assert_eq!(error.code, ErrorCode::ThreadNotFound);
    }
    store.cleanup();
}

#[tokio::test]
async fn like_metacharacters_in_a_partial_id_match_literally_not_as_wildcards() {
    let store = temp_store();
    let _ = create(&store, None, None).await;
    let _ = create(&store, None, None).await;
    // "_" is a LIKE single-char wildcard; unescaped it would match every id
    // (all begin "th_..."). Escaped, "th%" / "_" must be treated literally and
    // match nothing, since no id literally contains "%" or begins "th_%".
    let pct = threads::resolve(ResolveInput {
        thread_id: "th%".into(),
        registry_path: Some(path_str(&store.registry_path)),
    })
    .await;
    assert!(!pct.is_ok());
    if let OpResult::Err { error } = pct {
        assert_eq!(error.code, ErrorCode::ThreadNotFound);
    }
    store.cleanup();
}

#[tokio::test]
async fn list_threads_cwd_returns_only_that_cwds_threads() {
    let store = temp_store();
    let a1 = create(&store, None, Some("/work/a")).await;
    let a2 = create(&store, None, Some("/work/a")).await;
    let _ = create(&store, None, Some("/work/b")).await;

    let scoped = threads::list_threads(Some(ListThreadsInput {
        cwd: Some("/work/a".into()),
        registry_path: Some(path_str(&store.registry_path)),
    }))
    .await;
    assert!(scoped.is_ok());
    if let OpResult::Ok { value } = &scoped {
        assert_eq!(value.len(), 2);
        let ids: std::collections::HashSet<&str> =
            value.iter().map(|t| t.thread_id.as_str()).collect();
        assert_eq!(
            ids,
            std::collections::HashSet::from([a1.as_str(), a2.as_str()])
        );
        for t in value {
            assert_eq!(t.cwd.as_deref(), Some("/work/a"));
        }
    }

    let all = threads::list_threads(Some(ListThreadsInput {
        cwd: None,
        registry_path: Some(path_str(&store.registry_path)),
    }))
    .await;
    assert!(all.is_ok());
    if let OpResult::Ok { value } = all {
        assert_eq!(value.len(), 3);
    }
    store.cleanup();
}

#[tokio::test]
async fn an_empty_cwd_lists_nothing_without_failing() {
    let store = temp_store();
    let _ = create(&store, None, Some("/work/a")).await;
    let empty = threads::list_threads(Some(ListThreadsInput {
        cwd: Some("/elsewhere".into()),
        registry_path: Some(path_str(&store.registry_path)),
    }))
    .await;
    assert!(empty.is_ok());
    if let OpResult::Ok { value } = empty {
        assert!(value.is_empty());
    }
    store.cleanup();
}

#[tokio::test]
async fn the_last_listed_thread_is_the_most_recently_created_insertion_order_tie_break() {
    let store = temp_store();
    let _ = create(&store, Some("first"), None).await;
    let _ = create(&store, Some("second"), None).await;
    let last = create(&store, Some("third"), None).await;

    let listed = threads::list_threads(Some(ListThreadsInput {
        cwd: None,
        registry_path: Some(path_str(&store.registry_path)),
    }))
    .await;
    assert!(listed.is_ok());
    if let OpResult::Ok { value } = listed {
        assert_eq!(value.len(), 3);
        assert_eq!(value.last().unwrap().thread_id, last);
    }
    store.cleanup();
}
