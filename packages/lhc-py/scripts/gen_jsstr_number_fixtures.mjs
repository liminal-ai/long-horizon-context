/**
 * Node oracle for ECMAScript Number::toString / JSON.stringify number spelling.
 *
 * Emits tests/fixtures/jsstr-number-cases.json — a list of
 * { name, value, expected } where `expected` is JSON.stringify(value) from
 * THIS node runtime. Value is re-encoded as a JSON number literal so the
 * Python test can JSON.parse it back to a float without spelling drift in
 * the fixture's value field itself (the expected field is the contract).
 *
 * Regenerate deliberately (the committed fixture is the contract):
 *   node scripts/gen_jsstr_number_fixtures.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {Array<[string, number]>} */
const named = [
  // The six values that exposed the py defect:
  ["1e21", 1e21],
  ["1e-6", 1e-6],
  ["1e-7", 1e-7],
  ["1e20", 1e20],
  ["1.23456789e23", 1.23456789e23],
  ["5e-324", 5e-324],
  // Signs of the same:
  ["neg_1e21", -1e21],
  ["neg_1e-6", -1e-6],
  ["neg_1e-7", -1e-7],
  ["neg_1e20", -1e20],
  ["neg_1.23456789e23", -1.23456789e23],
  // Boundary triplet 1e20 / 1e21 / 1e22:
  ["1e22", 1e22],
  ["neg_1e22", -1e22],
  // 0.1, 2^53-1, -0, max float:
  ["0.1", 0.1],
  ["neg_0.1", -0.1],
  ["max_safe_integer", Number.MAX_SAFE_INTEGER],
  ["neg_max_safe_integer", -Number.MAX_SAFE_INTEGER],
  ["neg_zero", -0],
  ["pos_zero", 0],
  ["max_float", 1.7976931348623157e308],
  ["neg_max_float", -1.7976931348623157e308],
  // Extra decimal-band / scientific-band samples:
  ["1.0", 1.0],
  ["3.0", 3.0],
  ["-3.0", -3.0],
  ["1e3", 1e3],
  ["2.5e-3", 2.5e-3],
  ["9.999999e-7", 9.999999e-7],
  ["1.5e-7", 1.5e-7],
  ["1e-100", 1e-100],
  ["0.0000012", 0.0000012],
  ["123.45", 123.45],
];

// 20 deterministic pseudo-random floats (mulberry32) so regeneration is stable.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(0x6a09e667);
/** @type {Array<[string, number]>} */
const randoms = [];
for (let i = 0; i < 20; i++) {
  // Mix magnitudes across decimal and scientific bands (positive and negative).
  const u = rng();
  const exp = Math.floor(rng() * 80) - 40; // roughly 1e-40 .. 1e39
  let v = (u + 0.1) * 10 ** exp;
  if (rng() < 0.5) v = -v;
  // Avoid non-finite:
  if (!Number.isFinite(v) || v === 0) v = 0.123456789 * (i + 1);
  randoms.push([`random_${i}`, v]);
}

const all = [...named, ...randoms];
const seen = new Set();
const cases = all.map(([name, value]) => {
  if (seen.has(name)) throw new Error(`duplicate name: ${name}`);
  seen.add(name);
  // value encoded as a JSON number so Python loads the same IEEE bit pattern
  // Node used (via JSON.parse). expected is JSON.stringify of that number.
  const valueJson = JSON.stringify(value);
  const expected = JSON.stringify(value);
  return { name, value: JSON.parse(valueJson), valueJson, expected };
});

// Nested object/list forms of the six defect values — byte-equal contract
// includes containers (key order fixed).
const nestedValues = {
  six: {
    a: 1e21,
    b: 1e-6,
    c: 1e-7,
    d: 1e20,
    e: 1.23456789e23,
    f: 5e-324,
  },
  arr: [1e21, 1e-6, 1e-7, 1e20, 1.23456789e23, 5e-324, -1e21, -1e-7],
};
cases.push({
  name: "nested_object_six",
  value: nestedValues.six,
  valueJson: JSON.stringify(nestedValues.six),
  expected: JSON.stringify(nestedValues.six),
});
cases.push({
  name: "nested_array_six",
  value: nestedValues.arr,
  valueJson: JSON.stringify(nestedValues.arr),
  expected: JSON.stringify(nestedValues.arr),
});

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "jsstr-number-cases.json");
writeFileSync(out, JSON.stringify(cases, null, 2) + "\n");
console.log(`wrote ${cases.length} cases to ${out}`);

// Sanity: print the six defect spellings
for (const name of ["1e21", "1e-6", "1e-7", "1e20", "1.23456789e23", "5e-324"]) {
  const c = cases.find((x) => x.name === name);
  console.log(`  ${name}: ${c.expected}`);
}
