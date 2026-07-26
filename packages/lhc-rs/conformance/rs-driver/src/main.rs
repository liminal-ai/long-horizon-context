// Mirror of ts-driver.mjs — identical inputs, Rust implementation.
use lhc::intake_stream::MessageEventInput;
use lhc::shared_tech::errors::OpResult;
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{intake_stream, messages, threads};
use serde_json::{json, Map, Value};

fn ev(kind: &str, key: &str, actor: &str, payload: Value) -> MessageEventInput {
    let Value::Object(payload) = payload else { panic!("payload must be object") };
    MessageEventInput {
        event_kind: kind.into(),
        idempotency_key: Some(key.into()),
        actor: actor.into(),
        harness: "conformance".into(),
        payload,
        extra: Map::new(),
    }
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (file_path, registry_path, mode) = (&args[1], &args[2], args[3].as_str());
    let usage = json!({
        "input_tokens": 9007199254740991i64,
        "cached_input_tokens": 0.1,
        "huge": 1e21,
        "astral-𝔘": "naïve✓𝒳",
        "nested": { "cache_write": 0, "provider": "openai-codex", "ratio": 1e-7 },
    });
    if mode == "create" {
        match threads::new_thread(NewThreadInput {
            file_path: file_path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(registry_path.clone()),
        })
        .await
        {
            OpResult::Ok { .. } => {}
            OpResult::Err { error } => panic!("{}", error.reason),
        }
        let batch = vec![
            ev("user_prompt", "k1", "user", json!({ "text": "conformance v5 prompt" })),
            ev("assistant_text", "k2", "assistant", json!({ "text": "answer one", "providerUsage": usage })),
            ev("turn_end", "k3", "system", json!({ "outcome": "aborted", "outcomeReason": "user cancelled ✂", "startedAt": "2026-07-01T12:00:00.000Z", "endedAt": "2026-07-01T12:00:04.250Z" })),
            ev("user_prompt", "k4", "user", json!({ "text": "second" })),
            ev("assistant_text", "k5", "assistant", json!({ "text": "no usage" })),
            ev("turn_end", "k6", "system", json!({})),
        ];
        match intake_stream::message_events(ThreadRef::file_path(file_path.as_str()), &batch).await {
            OpResult::Ok { .. } => {}
            OpResult::Err { error } => panic!("{}", error.reason),
        }
    } else {
        match messages::list(ThreadRef::file_path(file_path.as_str()), None).await {
            OpResult::Ok { .. } => {}
            OpResult::Err { error } => panic!("{}", error.reason),
        }
    }
    println!("rs-driver ok: {mode}");
}
