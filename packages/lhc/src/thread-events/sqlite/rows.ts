export interface ThreadRow {
  thread_id: string;
  client_thread_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  thread_event_id: string;
  thread_id: string;
  event_order: number;
  schema_version: string;
  event_kind: string;
  idempotency_key: string;
  actor_json: string;
  harness_json: string;
  origin_json: string | null;
  recorded_at: string;
  occurred_at: string | null;
  payload_json: string;
}

export interface MessageRow {
  message_id: string;
  thread_id: string;
  message_order: number;
  message_kind: string;
  actor_json: string;
  status: string;
  created_at: string;
  source_event_id: string;
  source_event_order: number;
}

export interface MessageBlockRow {
  block_id: string;
  message_id: string;
  thread_id: string;
  block_order: number;
  block_kind: string;
  payload_json: string;
  source_event_id: string;
  source_event_order: number;
}
