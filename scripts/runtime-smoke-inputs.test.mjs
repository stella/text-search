import assert from "node:assert/strict";
import { test } from "node:test";

import { readRuntimeSmokeMatches } from "./runtime-smoke-inputs.mjs";

void test("validates the consumed fields of actual-shaped engine matches", () => {
  /** @satisfies {import("../src/types").Match[]} */
  const matches = [
    { pattern: 0, start: 0, end: 8, text: "Ing. Jan" },
    { pattern: 1, start: 9, end: 14, text: "Novak", name: "surname", distance: 0 },
  ];
  assert.deepEqual(readRuntimeSmokeMatches(matches), [
    { text: "Ing. Jan" },
    { text: "Novak", name: "surname", distance: 0 },
  ]);
  const sparse = [];
  sparse.length = 1;
  for (const malformed of [
    null,
    {},
    [null],
    [{}],
    [{ text: 1 }],
    [{ text: "x", name: false }],
    [{ text: "x", distance: "0" }],
    sparse,
  ])
    assert.throws(() => readRuntimeSmokeMatches(malformed), TypeError);
});
