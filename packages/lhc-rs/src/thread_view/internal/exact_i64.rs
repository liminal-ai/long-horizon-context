//! Shared exact integer conversion for Wave 6 thread-view readers.
//!
//! Private to `thread_view` — not a public/test surface. Callers keep their
//! own diagnostic wording (`column X not integer` vs `label must be an integer`).

/// `2^63` — exact in f64; exclusive upper bound for signed 64-bit integers.
///
/// Note: `i64::MAX as f64` rounds to this value, so an upper bound of
/// `<= i64::MAX as f64` would incorrectly accept `9223372036854775808.0` and
/// saturate on cast.
pub(crate) const F64_I64_MAX_EXCLUSIVE: f64 = 9_223_372_036_854_775_808.0;

/// Convert a finite integral f64 to `i64` when exactly representable in range.
///
/// Rejects non-finite values, fractions, `f >= 2^63`, values below `i64::MIN`,
/// and imprecise floats whose cast is not a fixed point. Accepts `i64::MIN`
/// (exactly representable as a real).
pub(crate) fn f64_to_exact_i64(f: f64) -> Option<i64> {
    if !f.is_finite() || f != f.trunc() {
        return None;
    }
    if f < i64::MIN as f64 || f >= F64_I64_MAX_EXCLUSIVE {
        return None;
    }
    let i = f as i64;
    if i as f64 != f {
        return None;
    }
    Some(i)
}
