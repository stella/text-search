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
