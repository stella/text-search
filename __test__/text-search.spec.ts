import { describe, expect, test } from "bun:test";

import { TextSearch } from "../src";

describe("TextSearch", () => {
  test("basic matching", () => {
    const ts = new TextSearch(["foo", "bar"]);
    expect(ts.length).toBe(2);
    expect(ts.isMatch("hello foo")).toBe(true);
    expect(ts.isMatch("xyz")).toBe(false);
  });

  test("findIter returns matches", () => {
    const ts = new TextSearch(["foo", "bar"]);
    const matches = ts.findIter("foo bar foo");
    expect(matches.length).toBeGreaterThan(0);
    const texts = matches.map((m) => m.text);
    expect(texts).toContain("foo");
    expect(texts).toContain("bar");
  });

  test("named patterns", () => {
    const ts = new TextSearch([
      { pattern: "\\d+", name: "number" },
      { pattern: "[a-z]+", name: "word" },
    ]);
    const matches = ts.findIter("abc 123");
    expect(matches.length).toBe(2);
    const named = matches.find(
      (m) => m.name === "number",
    );
    expect(named).toBeDefined();
    expect(named!.text).toBe("123");
  });

  test("whichMatch", () => {
    const ts = new TextSearch([
      "foo",
      "bar",
      "baz",
    ]);
    const which = ts.whichMatch("foo and baz");
    expect(which).toContain(0);
    expect(which).toContain(2);
    expect(which).not.toContain(1);
  });

  test("replaceAll", () => {
    const ts = new TextSearch([
      "\\d{2}\\.\\d{2}\\.\\d{4}",
      "\\+?\\d{9,12}",
    ]);
    const result = ts.replaceAll(
      "Born 15.03.1990, phone +420123456789",
      ["[DATE]", "[PHONE]"],
    );
    expect(result).toBe(
      "Born [DATE], phone [PHONE]",
    );
  });

  test("replaceAll wrong count throws", () => {
    const ts = new TextSearch(["a", "b"]);
    expect(() =>
      ts.replaceAll("ab", ["x"]),
    ).toThrow();
  });
});

// ─── Auto-optimization ──────────────────────

describe("auto-optimization", () => {
  test("large alternation is isolated", () => {
    // 80-branch alternation + simple pattern
    const titles = Array.from(
      { length: 80 },
      (_, i) => `title${i}`,
    ).join("|");
    const bigPattern = `(?:${titles})\\s+\\w+`;
    const smallPattern = "\\d+";

    // Should not throw or be slow
    const ts = new TextSearch(
      [bigPattern, smallPattern],
      { maxAlternations: 50 },
    );

    expect(ts.isMatch("title42 test")).toBe(true);
    expect(ts.isMatch("123")).toBe(true);
  });

  test("small alternation stays shared", () => {
    const ts = new TextSearch(
      ["a|b|c", "d|e|f"],
      { maxAlternations: 50 },
    );
    const matches = ts.findIter("a d");
    expect(matches).toHaveLength(2);
  });

  test("pattern indices preserved after split", () => {
    const titles = Array.from(
      { length: 80 },
      (_, i) => `t${i}`,
    ).join("|");

    const ts = new TextSearch(
      [
        "first",
        `(?:${titles})`, // isolated (>50 alts)
        "third",
      ],
      { maxAlternations: 50 },
    );

    const matches = ts.findIter("first t42 third");
    const patterns = matches.map(
      (m) => m.pattern,
    );

    // Original indices should be 0, 1, 2
    expect(patterns).toContain(0);
    expect(patterns).toContain(1);
    expect(patterns).toContain(2);
  });
});

// ─── Options ────────────────────────────────

describe("options", () => {
  test("unicodeBoundaries default true", () => {
    const ts = new TextSearch(["\\bp\\b"]);
    // Unicode \b: p inside čáp is not a word boundary
    expect(ts.findIter("čáp")).toHaveLength(0);
  });

  test("unicodeBoundaries false", () => {
    const ts = new TextSearch(["\\bp\\b"], {
      unicodeBoundaries: false,
    });
    // ASCII \b: č is not ASCII word char → boundary
    expect(ts.findIter("čáp")).toHaveLength(1);
  });

  test("wholeWords", () => {
    const ts = new TextSearch(["test"], {
      wholeWords: true,
    });
    expect(ts.findIter("testing")).toHaveLength(0);
    expect(ts.findIter("a test b")).toHaveLength(
      1,
    );
  });
});

// ─── Fuzzy matching ──────────────────────────

describe("fuzzy matching", () => {
  test("fuzzy pattern matches with edit distance", () => {
    const ts = new TextSearch([
      { pattern: "Smith", distance: 1 },
      "exact",
    ]);
    const matches = ts.findIter(
      "Smi1h and exact here",
    );
    const texts = matches.map((m) => m.text);
    expect(texts).toContain("Smi1h");
    expect(texts).toContain("exact");

    // distance is preserved on fuzzy matches
    const fuzzyMatch = matches.find(
      (m) => m.text === "Smi1h",
    );
    expect(fuzzyMatch!.distance).toBe(1);

    // exact matches have no distance
    const exactMatch = matches.find(
      (m) => m.text === "exact",
    );
    expect(exactMatch!.distance).toBeUndefined();
  });

  test("fuzzy pattern indices preserved", () => {
    const ts = new TextSearch([
      "literal",
      { pattern: "Novak", distance: 1 },
      "\\d+",
    ]);
    const matches = ts.findIter(
      "literal Nowak 42",
    );
    const byPattern = new Map(
      matches.map((m) => [m.pattern, m.text]),
    );
    expect(byPattern.get(0)).toBe("literal");
    expect(byPattern.get(1)).toBe("Nowak");
    expect(byPattern.get(2)).toBe("42");
  });

  test("fuzzy with auto distance", () => {
    const ts = new TextSearch([
      { pattern: "Gaislerova", distance: "auto" },
    ]);
    // auto: 10 chars → distance 2
    expect(
      ts.isMatch("Gais1erova"),
    ).toBe(true);
  });

  test("fuzzy named patterns", () => {
    const ts = new TextSearch([
      {
        pattern: "Praha",
        distance: 1,
        name: "city",
      },
    ]);
    const matches = ts.findIter("Praha here");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.name).toBe("city");
    expect(matches[0]!.text).toBe("Praha");
  });

  test("replaceAll with mixed fuzzy + exact", () => {
    const ts = new TextSearch([
      { pattern: "Smith", distance: 1 },
      "exact",
    ]);
    const result = ts.replaceAll(
      "Smi1h and exact",
      ["[NAME]", "[WORD]"],
    );
    expect(result).toBe("[NAME] and [WORD]");
  });
});
