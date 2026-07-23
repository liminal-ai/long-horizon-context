//! Tool-call payload must not type-check as a user-prompt override.

#[path = "../fixtures/valid_event.rs"]
mod valid_event;

use valid_event::{
    ToolCallPayload, UserPromptOverrides, kind, valid_event,
};

fn main() {
    let _ = valid_event(
        kind::USER_PROMPT,
        UserPromptOverrides {
            payload: Some(ToolCallPayload {
                tool_call_id: "x".into(),
                tool_name: "y".into(),
                arguments: Default::default(),
            }),
            ..Default::default()
        },
    );
}
