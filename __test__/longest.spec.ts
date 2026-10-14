import { describe, expect, test } from "bun:test";

import { TextSearch } from "../src";

describe("literal longest selection", () => {
  test.each([false, true])(
    "pattern order does not select shorter matches, allLiteral=%s",
    (allLiteral) => {
      for (const patterns of [
        ["a", "aa", "aaa"],
        ["aaa", "aa", "a"],
        ["aa", "a", "aaa"],
      ]) {
        const search = new TextSearch(patterns, { allLiteral });
        expect(search.findIter("aaaa").map(({ text }) => text)).toEqual(["aaa", "a"]);
        expect(
          search.replaceAll(
            "aaaa",
            patterns.map((pattern) => `[${pattern}]`),
          ),
        ).toBe("[aaa][a]");
      }
    },
  );

  test.each([false, true])(
    "ASCII word filtering happens before longest selection, allLiteral=%s",
    (allLiteral) => {
      for (const patterns of [
        ["a", "a b"],
        ["a b", "a"],
      ]) {
        const search = new TextSearch(patterns, {
          allLiteral,
          wholeWords: true,
          unicodeBoundaries: false,
        });
        expect(search.findIter("a bc").map(({ text }) => text)).toEqual(["a"]);
        expect(search.findIter("a b").map(({ text }) => text)).toEqual(["a b"]);
        expect(
          search.replaceAll(
            "a bc",
            patterns.map((pattern) => `[${pattern}]`),
          ),
        ).toBe("[a] bc");
      }
    },
  );

  test("named and mixed-engine literals select the longest span", () => {
    for (const suffix of [[], [/z+/]]) {
      const search = new TextSearch([
        { pattern: "aa", name: "short" },
        { pattern: "aaa", name: "long" },
        ...suffix,
      ]);
      expect(search.findIter("aaa")).toEqual([
        { pattern: 1, start: 0, end: 3, text: "aaa", name: "long" },
      ]);
    }
  });
});
