use lhc::SkippedRecord;
use serde_json::{Value, json, to_value};

#[test]
fn skipped_record_public_wire_uses_camel_case_fields_for_both_variants() {
    let cases = [
        (
            SkippedRecord::OrphanedMessage {
                message_id: "message-1".into(),
                turn_id: "turn-1".into(),
                reason: "orphaned message".into(),
            },
            json!({
                "kind": "orphaned_message",
                "messageId": "message-1",
                "turnId": "turn-1",
                "reason": "orphaned message",
            }),
        ),
        (
            SkippedRecord::DanglingChunkMember {
                chunk_id: "chunk-1".into(),
                turn_id: "turn-2".into(),
                reason: "dangling chunk member".into(),
            },
            json!({
                "kind": "dangling_chunk_member",
                "chunkId": "chunk-1",
                "turnId": "turn-2",
                "reason": "dangling chunk member",
            }),
        ),
    ];

    for (record, expected) in cases {
        let actual = to_value(record).expect("SkippedRecord serializes");
        assert_eq!(actual, expected);

        let Value::Object(fields) = actual else {
            panic!("SkippedRecord must serialize as an object");
        };
        for snake_case_key in ["message_id", "chunk_id", "turn_id"] {
            assert!(!fields.contains_key(snake_case_key));
        }
    }
}
