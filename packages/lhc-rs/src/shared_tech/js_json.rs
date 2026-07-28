//! JS string/JSON parity helpers — the Rust counterpart of lhc-py's
//! `shared_tech/_jsstr.py`. No TS source counterpart: the TS code gets these
//! semantics for free from the JS runtime; ports must reproduce them.
//!
//! REAL IMPLEMENTATION IN PHASE 1 (like the sqlite seam, this is
//! infrastructure the skeletons and tests stand on, not ported behavior).
//!
//! THE RULE (gate-enforced): any ported code producing persisted, hashed, or
//! token-counted bytes calls `js_json_stringify` — never `serde_json::to_string`
//! directly. `serde_json` spells integral floats `1.0`; JSON.stringify spells
//! them `1`. That one-character drift corrupted digests in the Python port
//! until audited; here the gate greps for violations.
//!
//! Documented, accepted divergences from JS (carried over from the lhc-py audit):
//! - Integers beyond 2^53 print exactly (JS rounds through f64).
//! - `js_slice` cannot keep a lone surrogate from a mid-pair slice (Rust
//!   strings are valid UTF-8); the split pair is dropped instead.
//!
//! Small-exponent floats (`0 < |x| < 1e-6`) are Node-oracle-covered
//! (Amendment H): lowercase `e` spelling with shortest round-trip significand
//! and bare negative exponent (`1e-7`, never `1e-07`). `|x| == 1e-6` through
//! `|x| < 1e21` stay on decimal `Display`. `|x| ≥ 1e21` uses Node's
//! exponent form (`1e+21`) via `serde_json::Number` spelling (Amendment I —
//! profile `lowerBound` / diagnostics make this reachable).

use serde::Serialize;
use serde_json::Value;

/// UTF-16 code units matching JS `s.charCodeAt(i)` for each index.
pub fn js_char_codes(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// JS `s.length` — UTF-16 code-unit count.
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `String.prototype.trim` — WhiteSpace + LineTerminator + BOM (U+FEFF).
///
/// ECMAScript WhiteSpace + LineTerminator + BOM (U+FEFF) for trim/trimStart.
///
/// Deliberately excludes U+0085 NEL (JS does not trim it; Rust `str::trim` does).
fn is_js_trim_char(c: char) -> bool {
    matches!(
        c,
        '\u{0009}' // TAB
        | '\u{000B}' // VT
        | '\u{000C}' // FF
        | '\u{0020}' // SP
        | '\u{00A0}' // NBSP
        | '\u{FEFF}' // BOM / ZWNBSP
        | '\u{000A}' // LF
        | '\u{000D}' // CR
        | '\u{2028}' // LS
        | '\u{2029}' // PS
        | '\u{1680}'
        | '\u{2000}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}'
    )
}

/// JS `String.prototype.trim` — WhiteSpace + LineTerminator + BOM (U+FEFF).
///
/// Covers TAB/VT/FF/SP/NBSP, Unicode Space_Separator (Zs), LF/CR/LS/PS, and
/// BOM. Use wherever a Wave 1 body translates JS `.trim()`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_trim_char)
}

/// JS `String.prototype.trimStart` — same character set as [`js_trim`].
pub fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_trim_char)
}

/// JS `String.prototype.trimEnd` — same character set as [`js_trim`].
pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_trim_char)
}

/// JS `s.slice(start, end)` over UTF-16 code units (negative indices count
/// from the end). A slice boundary that splits a surrogate pair drops the
/// lone half — see module divergence notes.
pub fn js_slice(s: &str, start: i64, end: Option<i64>) -> String {
    let units = js_char_codes(s);
    let len = units.len() as i64;
    let clamp = |index: i64| -> usize {
        let idx = if index < 0 { len + index } else { index };
        idx.clamp(0, len) as usize
    };
    let start_i = clamp(start);
    let end_i = clamp(end.unwrap_or(len));
    if end_i <= start_i {
        return String::new();
    }
    // from_utf16_lossy would inject U+FFFD for split pairs; strip those
    // replacement units at the cut edges instead so output stays clean.
    let mut slice = &units[start_i..end_i];
    if let Some(&first) = slice.first()
        && (0xDC00..=0xDFFF).contains(&first)
    {
        slice = &slice[1..];
    }
    if let Some(&last) = slice.last()
        && (0xD800..=0xDBFF).contains(&last)
    {
        slice = &slice[..slice.len() - 1];
    }
    String::from_utf16(slice).unwrap_or_else(|_| String::from_utf16_lossy(slice))
}

/// JSON.stringify-compatible compact dump: no spaces, insertion-ordered
/// object keys (preserve_order), integral floats spelled as integers,
/// non-ASCII characters raw (not \u-escaped).
pub fn js_json_stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

/// `JSON.stringify(value, null, 2)` — same leaf spelling as
/// [`js_json_stringify`], with two-space indentation.
pub fn js_json_stringify_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_value_pretty(&mut out, value, 0);
    out
}

/// Serialize any `Serialize` value through the JS spelling — the one lane
/// for persisted/hashed struct bytes (the Python port's shared dataclass
/// encoder, made a first-class citizen from Wave 0).
pub fn js_json_stringify_of<T: Serialize>(value: &T) -> Result<String, serde_json::Error> {
    Ok(js_json_stringify(&serde_json::to_value(value)?))
}

/// JS `String(number)` — template-literal / diagnostic spelling.
///
/// Handles `NaN`, `±Infinity`, and `-0 → 0` directly. Do **not** route
/// non-finite values through `Value::from(f64)` / `serde_json::Number`: serde
/// maps those to JSON `null`. Finite leaves reuse [`write_number`] (Amendment H
/// small-exponent boundary included).
pub fn js_string_of_number(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n.is_infinite() {
        return if n.is_sign_positive() {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        };
    }
    // JS ToString(-0) === "0".
    let n = if n == 0.0 { 0.0 } else { n };
    match serde_json::Number::from_f64(n) {
        Some(num) => {
            let mut out = String::new();
            write_number(&mut out, &num);
            out
        }
        None => unreachable!("finite f64 always converts to serde_json::Number"),
    }
}

/// Build a JSON number leaf for object/array construction before
/// [`js_json_stringify`]. Finite values keep Node spelling; non-finite become
/// JSON `null` (JSON.stringify contract), never a second Display formatter.
pub fn js_number_value(n: f64) -> Value {
    if !n.is_finite() {
        return Value::Null;
    }
    let n = if n == 0.0 { 0.0 } else { n };
    // Safe-integer integrals use an i64 Number leaf so Value PartialEq matches
    // `json!(N)` and stringify stays bare (`3` not `3.0`). Fractions and
    // non-safe magnitudes stay on the f64 Number lane (Amendment H/I spelling).
    if n == n.trunc() && n.abs() <= 9_007_199_254_740_992.0 {
        return Value::Number((n as i64).into());
    }
    match serde_json::Number::from_f64(n) {
        Some(num) => Value::Number(num),
        None => Value::Null,
    }
}

/// JS `String(value ?? "")` for JSON-representable runtime values.
///
/// Number leaves go through [`js_string_of_number`] so diagnostic and
/// nullish-string paths share one spelling lane.
pub fn js_string_nullish(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(true)) => "true".to_string(),
        Some(Value::Bool(false)) => "false".to_string(),
        Some(Value::Number(n)) => {
            if let Some(f) = n.as_f64() {
                js_string_of_number(f)
            } else {
                // i64/u64-only Number — stringify via the JSON number lane.
                js_json_stringify(&Value::Number(n.clone()))
            }
        }
        Some(Value::Array(items)) => {
            // Array.prototype.toString → join(",") with recursive ToString;
            // null/undefined elements become empty.
            items
                .iter()
                .map(|item| match item {
                    Value::Null => String::new(),
                    other => js_string_nullish(Some(other)),
                })
                .collect::<Vec<_>>()
                .join(",")
        }
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => write_number(out, n),
        // serde_json's string escaping matches JSON.stringify: short escapes
        // for control chars, no escaping of non-ASCII or U+2028/U+2029.
        Value::String(s) => {
            out.push_str(&serde_json::to_string(s).expect("string serialization is infallible"))
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (key, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(
                    &serde_json::to_string(key).expect("string serialization is infallible"),
                );
                out.push(':');
                write_value(out, item);
            }
            out.push('}');
        }
    }
}

fn write_indent(out: &mut String, depth: usize) {
    for _ in 0..depth {
        out.push_str("  ");
    }
}

fn write_value_pretty(out: &mut String, value: &Value, depth: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => write_number(out, n),
        Value::String(s) => {
            out.push_str(&serde_json::to_string(s).expect("string serialization is infallible"))
        }
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push_str("[\n");
            for (i, item) in items.iter().enumerate() {
                write_indent(out, depth + 1);
                write_value_pretty(out, item, depth + 1);
                if i + 1 < items.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            write_indent(out, depth);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push_str("{\n");
            let mut iter = map.iter().peekable();
            while let Some((key, item)) = iter.next() {
                write_indent(out, depth + 1);
                out.push_str(
                    &serde_json::to_string(key).expect("string serialization is infallible"),
                );
                out.push_str(": ");
                write_value_pretty(out, item, depth + 1);
                if iter.peek().is_some() {
                    out.push(',');
                }
                out.push('\n');
            }
            write_indent(out, depth);
            out.push('}');
        }
    }
}

fn write_number(out: &mut String, n: &serde_json::Number) {
    if let Some(f) = n.as_f64() {
        // serde_json::Number can't hold NaN/Infinity, so JSON.stringify's
        // null-spelling for those is handled at construction, not here.
        if f == f.trunc() && f.abs() <= 9_007_199_254_740_992.0 {
            // JS spells integral numbers bare: 1.0 → "1", -0 → "0".
            let i = f as i64;
            out.push_str(&i.to_string());
            return;
        }
        if !n.is_i64() && !n.is_u64() {
            let abs = f.abs();
            if abs > 0.0 && abs < 1e-6 {
                // Amendment H — Node's small-exponent boundary: 0 < |x| < 1e-6
                // uses lowercase exponent form. serde_json::Number's finite
                // shortest spelling matches Node here (significand + bare
                // `e-N`, signed). Do not use `format!("{f}")` (decimal).
                out.push_str(&n.to_string());
            } else if abs >= 1e21 {
                // Amendment I — Node switches to `1e+21` / `-1.2e+21` at
                // |x| ≥ 1e21. `serde_json::Number` matches that form; Rust
                // `Display` emits full decimal digits and must not be used.
                out.push_str(&n.to_string());
            } else {
                // Decimal band: |x| == 1e-6 .. |x| < 1e21 (incl. 1e-6, 1e20).
                // Do not use Number spelling here — serde emits `1e-6` /
                // `1e+20` while Node keeps decimal.
                out.push_str(&format!("{f}"));
            }
            return;
        }
    }
    out.push_str(&n.to_string());
}
