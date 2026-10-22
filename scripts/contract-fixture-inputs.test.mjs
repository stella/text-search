import assert from "node:assert/strict";
import test from "node:test";

import {
  readDenyListData,
  readRegexMetadata,
} from "./contract-fixture-inputs.mjs";

void test("external deny-list data retains custom source membership and missing-index behavior", () => {
  const data = readDenyListData({
    originals: ["Example Company", "Secret Client", "Unannotated"],
    sources: [["bank"], ["custom-deny-list", "organization"]],
    patterns: ["example company", "secret client", "unannotated"],
  });
  assert.equal(
    data.sources.some((sources) => sources.includes("custom-deny-list")),
    true,
  );
  assert.equal(data.sources.at(0)?.includes("custom-deny-list"), false);
  assert.equal(data.sources.at(1)?.includes("custom-deny-list"), true);
  assert.deepEqual(data.sources.at(2) ?? [], []);
  assert.deepEqual(data.originals, [
    "Example Company",
    "Secret Client",
    "Unannotated",
  ]);
  assert.equal(
    readDenyListData({ originals: [], sources: [] }).sources.some((sources) =>
      sources.includes("custom-deny-list"),
    ),
    false,
  );
});

void test("external deny-list boundary rejects malformed containers and every malformed source row", () => {
  for (const value of [
    null,
    [],
    {},
    { originals: [], sources: null },
    { originals: [42], sources: [] },
    { originals: [], sources: ["custom-deny-list"] },
    { originals: [], sources: [["bank"], [42]] },
    { originals: [], sources: [[null]] },
  ])
    assert.throws(() => readDenyListData(value), TypeError);
});

void test("external regex metadata preserves labels, extra fields and absent entries", () => {
  const metadata = { label: "email", confidence: 0.95, id: "email-standard" };
  const entries = readRegexMetadata([metadata, undefined, null]);
  assert.deepEqual(entries.at(0), metadata);
  assert.equal(entries.at(1), undefined);
  assert.equal(entries.at(2), undefined);
  assert.equal(entries.at(3), undefined);
  for (const value of [
    null,
    {},
    [false],
    [42],
    [{}],
    [{ label: 42 }],
    [{ label: "email" }, { label: null }],
  ])
    assert.throws(() => readRegexMetadata(value), TypeError);
});
