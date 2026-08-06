/**
 * Generates fixtures/date-parse-cases.jsonl: Date.parse conformance for the
 * two fixed UTC shapes accepted by work_queue::date_parse_ms and
 * scheduler::parse_iso_to_millis (Amendment D / Node >=24.17).
 *
 * Each line: {name, input, expected} where `expected` is "invalid" when
 * Date.parse returns NaN, otherwise new Date(ms).toISOString() from THIS
 * node runtime — the oracle.
 *
 * Restricted to `YYYY-MM-DDTHH:mm:ssZ` and `YYYY-MM-DDTHH:mm:ss.sssZ`.
 * Node fallback-grammar forms (space separator, lowercase z, …) are NOT
 * included and must not widen the Rust parsers.
 *
 * Regenerate only deliberately (the committed file is the contract):
 *   node scripts/gen-date-parse-fixtures.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {Array<[string, string]>} */
const cases = [];
const seenNames = new Set();
const seenInputs = new Set();

function add(name, input) {
  if (seenNames.has(name)) {
    throw new Error(`duplicate fixture name: ${name}`);
  }
  if (seenInputs.has(input)) {
    throw new Error(`duplicate fixture input: ${JSON.stringify(input)} (name ${name})`);
  }
  seenNames.add(name);
  seenInputs.add(input);
  cases.push([name, input]);
}

function bothForms(name, ymd, hms, ms) {
  // ms: null → only no-fraction form; number → both .sss and no-fraction when ms===0
  if (ms === null) {
    add(`${name}_nofraction`, `${ymd}T${hms}Z`);
    return;
  }
  const sss = String(ms).padStart(3, "0");
  add(`${name}_ms`, `${ymd}T${hms}.${sss}Z`);
  if (ms === 0) {
    add(`${name}_nofraction`, `${ymd}T${hms}Z`);
  }
}

// ── ordinary valid ───────────────────────────────────────────────
bothForms("ordinary_mid", "2026-07-15", "12:34:56", 789);
// 2026-01-01T00:00:00(.000)Z is covered by jan_01 in the day matrix below.
bothForms("ordinary_end_of_day", "2026-12-31", "23:59:59", 999);

// ── leap / non-leap / century / 400-year ─────────────────────────
// 2024-02-29T00:00:00(.000)Z is covered by leap_feb_29 in the day matrix.
bothForms("leap_feb_29_2000", "2000-02-29", "12:00:00", 0);
bothForms("non_leap_feb_28_2025", "2025-02-28", "00:00:00", 0);
bothForms("century_non_leap_feb_28_1900", "1900-02-28", "00:00:00", 0);
// Node normalizes non-leap Feb 29 → Mar 1
bothForms("non_leap_feb_29_2025", "2025-02-29", "00:00:00", 0);
bothForms("century_non_leap_feb_29_1900", "1900-02-29", "00:00:00", 0);

// ── day overflow normalization (approved Node 24) ────────────────
// Feb 29–31 / Apr 31 for non-leap 2026 and leap 2024 live in the day matrix
// below (unique names). Keep only 31-day overflows for months not in that loop.
bothForms("jun_31", "2026-06-31", "00:00:00", 0);
bothForms("sep_31", "2026-09-31", "00:00:00", 0);
bothForms("nov_31", "2026-11-31", "00:00:00", 0);

// ── day field matrix across month lengths ────────────────────────
for (const day of ["00", "01", "28", "29", "30", "31", "32"]) {
  bothForms(`feb_${day}`, `2026-02-${day}`, "00:00:00", 0);
  bothForms(`apr_${day}`, `2026-04-${day}`, "00:00:00", 0);
  bothForms(`jan_${day}`, `2026-01-${day}`, "00:00:00", 0);
  bothForms(`leap_feb_${day}`, `2024-02-${day}`, "00:00:00", 0);
}

// ── month bounds / year-boundary ─────────────────────────────────
bothForms("month_00", "2026-00-15", "00:00:00", 0);
bothForms("month_01", "2026-01-15", "00:00:00", 0);
bothForms("month_12", "2026-12-15", "00:00:00", 0);
bothForms("month_13", "2026-13-01", "00:00:00", 0);
bothForms("year_boundary_dec_31", "2026-12-31", "00:00:00", 0);
bothForms("year_boundary_dec_31_hour24", "2026-12-31", "24:00:00", 0);

// ── time edge / hour-24 ──────────────────────────────────────────
bothForms("end_millis", "2026-01-01", "23:59:59", 999);
bothForms("hour_24", "2026-01-01", "24:00:00", 0);
bothForms("hour_24_nonzero_minute", "2026-01-01", "24:01:00", 0);
bothForms("hour_24_nonzero_second", "2026-01-01", "24:00:01", 0);
bothForms("hour_24_nonzero_millis", "2026-01-01", "24:00:00", 1);
bothForms("hour_25", "2026-01-01", "25:00:00", 0);
bothForms("minute_60", "2026-01-01", "00:60:00", 0);
bothForms("second_60", "2026-01-01", "00:00:60", 0);

// ── + / - / ASCII letter / non-ASCII digit in every numeric field ──
// Fullwidth digit U+FF10 (０). Field isolates keep the ISO template shape;
// non-ASCII expands UTF-8 byte length and must still be rejected.
const FW = "\uFF10";
const fullwidth = "２０２６-０１-０１T００:００:００.０００Z";
add("non_ascii_digits_fullwidth", fullwidth);

add("year_plus", "+026-01-01T00:00:00.000Z");
add("year_minus", "-026-01-01T00:00:00.000Z");
add("year_ascii_letter", "202A-01-01T00:00:00.000Z");
add("year_non_ascii_digit", `${FW}026-01-01T00:00:00.000Z`);

add("month_plus", "2026-+1-01T00:00:00.000Z");
add("month_minus", "2026--1-01T00:00:00.000Z");
add("month_ascii_letter", "2026-0A-01T00:00:00.000Z");
add("month_non_ascii_digit", `2026-${FW}1-01T00:00:00.000Z`);

add("day_plus", "2026-01-+1T00:00:00.000Z");
add("day_minus", "2026-01--1T00:00:00.000Z");
add("day_ascii_letter", "2026-01-0AT00:00:00.000Z");
add("day_non_ascii_digit", `2026-01-${FW}1T00:00:00.000Z`);

add("hour_plus", "2026-01-01T+0:00:00.000Z");
add("hour_minus", "2026-01-01T-0:00:00.000Z");
add("hour_ascii_letter", "2026-01-01TA0:00:00.000Z");
add("hour_non_ascii_digit", `2026-01-01T${FW}0:00:00.000Z`);

add("minute_plus", "2026-01-01T00:+0:00.000Z");
add("minute_minus", "2026-01-01T00:-0:00.000Z");
add("minute_ascii_letter", "2026-01-01T00:A0:00.000Z");
add("minute_non_ascii_digit", `2026-01-01T00:${FW}0:00.000Z`);

add("second_plus", "2026-01-01T00:00:+0.000Z");
add("second_minus", "2026-01-01T00:00:-0.000Z");
add("second_ascii_letter", "2026-01-01T00:00:A0.000Z");
add("second_non_ascii_digit", `2026-01-01T00:00:${FW}0.000Z`);

add("millis_plus", "2026-01-01T00:00:00.+00Z");
add("millis_minus", "2026-01-01T00:00:00.-00Z");
add("millis_ascii_letter", "2026-01-01T00:00:00.00AZ");
add("millis_non_ascii_digit", `2026-01-01T00:00:00.${FW}00Z`);

// ── separator mutations (fixed-form invalid; not Node fallback grammar) ──
add("sep_year_month_x", "2026x01-01T00:00:00.000Z");
add("sep_month_day_x", "2026-01x01T00:00:00.000Z");
add("sep_day_time_x", "2026-01-01x00:00:00.000Z");
add("sep_hour_min_x", "2026-01-01T00x00:00.000Z");
add("sep_min_sec_x", "2026-01-01T00:00x00.000Z");
add("sep_sec_frac_x", "2026-01-01T00:00:00x000Z");
add("sep_all_x", "2024x02x29x00x00x00.000Z");
// Do NOT include missing-Z / space / lowercase-z forms: Node accepts them via
// fallback grammar outside our two fixed UTC shapes (Amendment D).
add("trailing_junk", "2026-01-01T00:00:00.000Zx");
add("empty", "");
add("not_a_date", "not-a-date");

const lines = cases.map(([name, input]) => {
  const ms = Date.parse(input);
  const expected = Number.isNaN(ms) ? "invalid" : new Date(ms).toISOString();
  return JSON.stringify({ name, input, expected });
});

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "date-parse-cases.jsonl");
writeFileSync(out, lines.join("\n") + "\n");
console.log(`wrote ${cases.length} cases to ${out}`);
console.log(`node ${process.version}`);
