/**
 * Typed-ahead input during compaction.
 *
 * Once compact owns the settled session, input stops being forwarded. Bytes
 * typed from that moment are dropped — not buffered, not journalled, never
 * replayed. Replaying them into a replacement is a real duplicate-send hazard,
 * and holding them is what turned input delivery into a veto over a swap that
 * had already succeeded. The operator gets one line and resends.
 *
 * Input that started BEFORE ownership is not typed-ahead at all: it opens a
 * normal turn, and compact re-evaluates at that turn's settle.
 */

/** The one line. Nothing else about dropped input reaches the terminal. */
export const TYPED_AHEAD_RESEND_NOTICE = "input typed during compaction was not delivered — please resend";
