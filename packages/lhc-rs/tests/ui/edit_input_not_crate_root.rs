//! EditInput is a messages-domain named arg shape — not a crate-root/sdk export
//! (TS sdk.ts does not re-export the inline `{ messageId, content }` type).

fn main() {
    let _ = lhc::EditInput {
        message_id: "m1".into(),
        content: "x".into(),
    };
}
