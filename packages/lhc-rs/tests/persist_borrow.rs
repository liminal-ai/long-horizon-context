//! Compile-pass proof that persist transaction callbacks may borrow across `.await`.
//! Bodies remain Phase 1 `todo!("phase 2")` — runtime is notimpl; the signature is the contract.

use lhc::shared_tech::persist::{create_db_read_transaction, create_db_write_transaction};
use lhc::threads::ThreadRef;

#[tokio::test]
async fn create_db_read_transaction_accepts_async_callback_borrowing_across_await() {
    let _ = create_db_read_transaction(
        ThreadRef::file_path("/tmp/lhc-persist-borrow-read.sqlite"),
        |txn| {
            Box::pin(async move {
                let id_before = txn.thread_id.clone();
                let path_before = txn.file_path.clone();
                tokio::task::yield_now().await;
                let id_after = txn.thread_id.clone();
                let path_after = txn.file_path.clone();
                assert_eq!(id_before, id_after);
                assert_eq!(path_before, path_after);
                id_after
            })
        },
    )
    .await;
}

#[tokio::test]
async fn create_db_write_transaction_accepts_async_callback_borrowing_across_await() {
    let _ = create_db_write_transaction(
        ThreadRef::file_path("/tmp/lhc-persist-borrow-write.sqlite"),
        |txn| {
            Box::pin(async move {
                let id_before = txn.thread_id.clone();
                let path_before = txn.file_path.clone();
                tokio::task::yield_now().await;
                let id_after = txn.thread_id.clone();
                let path_after = txn.file_path.clone();
                assert_eq!(id_before, id_after);
                assert_eq!(path_before, path_after);
                id_after
            })
        },
        None,
    )
    .await;
}
