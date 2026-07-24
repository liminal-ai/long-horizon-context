//! Ported from packages/lhc/src/shared-tech/classify.ts.
//!
//! `safe_call` contains the host function: a thrown exception becomes `other`
//! and the adapter-owned timeout race becomes `timeout`, so host behavior cannot
//! crash a drain.

use std::panic::{AssertUnwindSafe, catch_unwind};

use futures::FutureExt;

use super::inference_types::{ModelCall, ModelCallFailureKind, ModelCallInput, ModelCallResult};

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        return (*s).to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "Box<Any>".to_string()
}

/// try/catch + timeout race around the host function.
pub async fn safe_call(
    call: &ModelCall,
    input: ModelCallInput,
    timeout_ms: i64,
) -> ModelCallResult {
    let timeout_ms_u = timeout_ms.max(0) as u64;
    let attempt = async {
        // The async wrapper folds synchronous panics into the same rejection
        // path — the host's promise contract is not trusted
        // (`classify.ts:18-25`). Invoking `call` may panic before a future
        // exists; panics inside the future are caught separately.
        let fut = match catch_unwind(AssertUnwindSafe(|| call(input))) {
            Ok(fut) => fut,
            Err(payload) => {
                return ModelCallResult::Err {
                    kind: ModelCallFailureKind::Other,
                    message: panic_message(payload),
                };
            }
        };
        match AssertUnwindSafe(fut).catch_unwind().await {
            Ok(result) => result,
            Err(payload) => ModelCallResult::Err {
                kind: ModelCallFailureKind::Other,
                message: panic_message(payload),
            },
        }
    };
    let timeout = async {
        tokio::time::sleep(std::time::Duration::from_millis(timeout_ms_u)).await;
        ModelCallResult::Err {
            kind: ModelCallFailureKind::Timeout,
            message: format!("model call timed out after {timeout_ms}ms"),
        }
    };
    // A host that resolves after the race resolves into nothing.
    futures::pin_mut!(attempt);
    futures::pin_mut!(timeout);
    match futures::future::select(attempt, timeout).await {
        futures::future::Either::Left((result, _timeout)) => result,
        futures::future::Either::Right((result, _attempt)) => result,
    }
}
