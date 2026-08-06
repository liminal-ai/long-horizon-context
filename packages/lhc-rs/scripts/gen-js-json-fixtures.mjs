/**
 * Generates fixtures/js-json-cases.jsonl: JSON.stringify conformance cases
 * for shared_tech/js_json.rs. Each line: {name, input, expected} where
 * `input` is raw JSON text and `expected` is JSON.stringify(JSON.parse(input))
 * as produced by THIS node runtime — the oracle.
 *
 * Regenerate only deliberately (the committed file is the contract):
 *   node scripts/gen-js-json-fixtures.mjs
 *
 * Deliberately excluded (documented divergences, unreachable in LHC data):
 * integers beyond 2^53, magnitudes ≥ 1e21, lone surrogates.
 *
 * Amendment H: magnitudes in (0, 1e-6) are included — Node small-exponent
 * spelling is oracle-covered (lowercase e, bare negative exponent).
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cases = [
  ["null", "null"],
  ["bool_true", "true"],
  ["bool_false", "false"],
  ["int", "42"],
  ["int_negative", "-7"],
  ["int_zero", "0"],
  ["float_integral", "1.0"],
  ["float_integral_negative", "-3.0"],
  ["float_negative_zero", "-0.0"],
  ["float_fraction", "0.3"],
  ["float_fraction_precise", "0.1"],
  ["float_sum_artifact", "0.30000000000000004"],
  ["float_small", "0.000001"],
  ["float_at_1e_minus_6", "1e-6"],
  ["float_decimal_just_above_1e_minus_6", "0.0000012"],
  ["float_just_below_1e_minus_6", "9.999999e-7"],
  ["float_just_below_1e_minus_6_negative", "-9.999999e-7"],
  ["float_1e_minus_7", "1e-7"],
  ["float_1e_minus_7_negative", "-1e-7"],
  ["float_1_5e_minus_7", "1.5e-7"],
  ["float_2_5e_minus_7", "2.5e-7"],
  ["float_1_23456e_minus_8", "1.23456e-8"],
  ["float_1e_minus_100", "1e-100"],
  ["float_min_subnormal_5e_minus_324", "5e-324"],
  ["object_nested_small_exponents", '{"n":1e-7,"m":-1.5e-7,"boundary":1e-6}'],
  ["array_nested_small_exponents", "[1e-7,1e-6,5e-324,[-9.999999e-7,2.5e-7]]"],
  ["int_large_safe", "9007199254740991"],
  ["exponent_normalized", "1e3"],
  ["exponent_fraction", "2.5e-3"],
  ["string_plain", '"hello"'],
  ["string_empty", '""'],
  ["string_escapes", '"line\\nbreak\\ttab\\\\slash\\"quote"'],
  ["string_control", '"\\u0000\\u0001\\u001f"'],
  ["string_unicode_raw", '"café 日本語"'],
  ["string_emoji", '"😀 ok"'],
  ["string_line_separators", '"a\\u2028b\\u2029c"'],
  ["array_empty", "[]"],
  ["array_mixed", '[1,"two",null,true,2.5]'],
  ["array_nested", "[[1,2],[3,[4]]]"],
  ["object_empty", "{}"],
  ["object_key_order", '{"zeta":1,"alpha":2,"mid":3}'],
  ["object_nested", '{"outer":{"inner":[1.0,{"deep":"v"}]},"tail":0.5}'],
  ["object_unicode_keys", '{"café":"x","日本":"y"}'],
  ["object_numeric_spellings", '{"a":1.0,"b":2,"c":0.25,"d":-0.0}'],
  [
    "realistic_facts_bag",
    '{"toolName":"bash","outcome":"failed","exitCode":127,"outputChars":58,"ratio":0.3,"pathMentions":["src/a.ts","b/c.js"]}',
  ],
  [
    "realistic_digest_input",
    '{"text":"SENTINEL","inputTokens":2000,"targetMinTokens":160,"targetAimTokens":240,"targetMaxTokens":400}',
  ],
];

const seen = new Set();
for (const [name] of cases) {
  if (seen.has(name)) throw new Error(`duplicate fixture name: ${name}`);
  seen.add(name);
}

const lines = cases.map(([name, input]) => {
  const expected = JSON.stringify(JSON.parse(input));
  return JSON.stringify({ name, input, expected });
});

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "js-json-cases.jsonl");
writeFileSync(out, lines.join("\n") + "\n");
console.log(`wrote ${cases.length} cases to ${out}`);
