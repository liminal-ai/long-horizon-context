use super::*;
use pretty_assertions::assert_eq;
use std::time::Duration;

#[test]
fn formats_epoch_leap_days_and_day_rollovers() {
    let cases = [
        (0, 0, "1970-01-01T00:00:00.000Z"),
        (946_684_799, 999, "1999-12-31T23:59:59.999Z"),
        (946_684_800, 0, "2000-01-01T00:00:00.000Z"),
        (951_782_400, 0, "2000-02-29T00:00:00.000Z"),
        (1_709_251_199, 123, "2024-02-29T23:59:59.123Z"),
        (1_709_251_200, 0, "2024-03-01T00:00:00.000Z"),
    ];

    for (secs, millis, expected) in cases {
        let time = UNIX_EPOCH + Duration::from_secs(secs) + Duration::from_millis(millis);
        assert_eq!(system_time_to_iso(time), expected);
    }
}

#[test]
fn formats_current_clock_as_normal_sortable_utc() {
    let before = system_time_to_iso(SystemTime::now());
    let after = system_time_to_iso(SystemTime::now() + Duration::from_millis(1));

    assert_eq!(before.len(), 24);
    assert!(
        before.starts_with("20"),
        "unexpected current UTC year: {before}"
    );
    assert!(before.ends_with('Z'));
    assert!(before <= after, "UTC timestamps must sort chronologically");
}
