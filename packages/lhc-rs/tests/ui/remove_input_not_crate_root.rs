//! RemoveInput is a messages-domain named arg shape — not a crate-root/sdk export
//! (TS sdk.ts does not re-export the inline `{ messageId }` type).

fn main() {
    let _ = lhc::RemoveInput {
        message_id: "m1".into(),
    };
}
