import { describe, expect, test } from "bun:test";

import { TextSearch } from "../src";

describe("literal overlapStrategy all", () => {
  test("preserves every occurrence independent of insertion order", () => {
    const haystack = "ababa";
    const expected = ["a", "ab", "aba", "ba", "a", "ab", "aba", "ba", "a"];

    for (const patterns of [
      ["a", "ab", "aba", "ba"],
      ["ba", "aba", "ab", "a"],
    ]) {
      const matches = new TextSearch(patterns, {
        allLiteral: true,
        overlapStrategy: "all",
      }).findIter(haystack);
      expect(matches.map(({ text }) => text)).toEqual(expected);
      expect(
        matches.every(
          ({ text, start, end }) => haystack.slice(start, end) === text,
        ),
      ).toBe(true);
    }
  });

  test("preserves named and mixed-engine literal occurrences", () => {
    const named = new TextSearch(
      [
        { pattern: "a", literal: true, name: "short" },
        { pattern: "aa", literal: true, name: "long" },
      ],
      { overlapStrategy: "all" },
    );
    expect(named.findIter("aa").map(({ name }) => name)).toEqual([
      "short",
      "long",
      "short",
    ]);

    const mixed = new TextSearch(["aa", /a+/], { overlapStrategy: "all" });
    expect(
      mixed
        .findIter("aaaa")
        .map(({ pattern, start, end }) => ({ pattern, start, end })),
    ).toEqual([
      { pattern: 0, start: 0, end: 2 },
      { pattern: 1, start: 0, end: 4 },
      { pattern: 0, start: 1, end: 3 },
      { pattern: 0, start: 2, end: 4 },
    ]);
  });

  test("split and unsplit literal routes use the same tie-break order", () => {
    const patterns = Array.from(
      { length: 20_000 },
      (_, index) => `term-${index}`,
    );
    patterns[0] = "alpha";
    patterns[1] = "beta";
    patterns[19_999] = "alpha beta";
    const options = {
      allLiteral: true,
      wholeWords: true,
      overlapStrategy: "all" as const,
    };

    const split = new TextSearch(patterns, {
      ...options,
      unicodeBoundaries: true,
    });
    const unsplit = new TextSearch(patterns, {
      ...options,
      unicodeBoundaries: false,
    });
    expect(Reflect.get(split, "engines")[0]?.type).toBe("split-ac");
    expect(Reflect.get(unsplit, "engines")[0]?.type).toBe("ac");
    expect(split.findIter("alpha beta")).toEqual(
      unsplit.findIter("alpha beta"),
    );
    expect(split.findIter("alpha beta").map(({ pattern }) => pattern)).toEqual([
      0, 19_999, 1,
    ]);
  });
});
