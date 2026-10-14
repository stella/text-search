import { describe, expect, test } from "bun:test";

import { TextSearch } from "../src";

const spans = (search: TextSearch, text: string) =>
  search
    .findIter(text)
    .map(({ pattern, start, end }) => ({ pattern, start, end }))
    .sort((a, b) => a.start - b.start || a.pattern - b.pattern || a.end - b.end);

describe('overlapStrategy "all"', () => {
  test.each([false, true])("literal occurrence invariant, allLiteral=%s", (allLiteral) => {
    const patterns = ["a", "aa", "aaa", "ba", "aba", "č", "ča", "bc", "abcdef"];
    for (const text of ["aaaa", "ababa", "čaa ča", "abcdef", "", "no matches"]) {
      const expected = [];
      for (const [pattern, literal] of patterns.entries()) {
        for (
          let start = text.indexOf(literal);
          start !== -1;
          start = text.indexOf(literal, start + 1)
        ) {
          expected.push({ pattern, start, end: start + literal.length });
        }
      }
      expected.sort((a, b) => a.start - b.start || a.pattern - b.pattern || a.end - b.end);
      const search = new TextSearch(patterns, { allLiteral, overlapStrategy: "all" });
      expect(spans(search, text)).toEqual(expected);
      const matches = search.findIter(text);
      expect(matches.map(({ start }) => start)).toEqual(
        matches.map(({ start }) => start).sort((a, b) => a - b),
      );
      for (const match of matches) {
        expect(text.slice(match.start, match.end)).toBe(match.text);
      }
    }
  });

  test("named literals preserve pattern indices and names", () => {
    const search = new TextSearch(
      [
        { pattern: "aaa", name: "long" },
        { pattern: "aa", name: "short" },
      ],
      { overlapStrategy: "all" },
    );
    const matches = search.findIter("aaa");
    expect(matches).toHaveLength(3);
    for (const match of matches) {
      expect(match.name).toBe(match.pattern === 0 ? "long" : "short");
    }
  });

  test("mixed engines retain all literal occurrences", () => {
    const search = new TextSearch(["aa", /a+/], { overlapStrategy: "all" });
    expect(search.findIter("aaa").filter(({ pattern }) => pattern === 0)).toHaveLength(2);
  });

  test.each([false, true])(
    "default literal selection is independent of pattern order, allLiteral=%s",
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
            patterns.map((pattern) => pattern.toUpperCase()),
          ),
        ).toBe("AAAA");
      }
    },
  );

  test("default selection and replacement remain non-overlapping", () => {
    const patterns = ["aa", "aaa"];
    const defaults = new TextSearch(patterns);
    let end = 0;
    for (const match of defaults.findIter("aaaa")) {
      expect(match.start).toBeGreaterThanOrEqual(end);
      end = match.end;
    }
    const search = new TextSearch(patterns, { overlapStrategy: "all" });
    expect(search.replaceAll("aaaa", ["SHORT", "LONG"])).toBe("LONGa");
  });
});
