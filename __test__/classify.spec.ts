import { describe, expect, test } from "bun:test";

import {
  classifyPatterns,
  countAlternations,
} from "../src/classify";

describe("countAlternations", () => {
  test("simple literal", () => {
    expect(countAlternations("foo")).toBe(1);
  });

  test("top-level alternation", () => {
    expect(countAlternations("a|b|c")).toBe(3);
  });

  test("alternation inside group", () => {
    expect(
      countAlternations("(?:a|b)|c"),
    ).toBe(2);
  });

  test("all inside one group — counts nested", () => {
    // Now counts max alternations at ANY depth,
    // not just top level, to catch DFA explosion
    expect(
      countAlternations(
        "(?:Ing\\.|Mgr\\.|Dr\\.)",
      ),
    ).toBe(3);
  });

  test("escaped pipe", () => {
    expect(countAlternations("a\\|b")).toBe(1);
  });

  test("pipe inside character class", () => {
    expect(countAlternations("[a|b]")).toBe(1);
  });

  test("large alternation", () => {
    const alt = Array.from(
      { length: 80 },
      (_, i) => `title${i}`,
    ).join("|");
    expect(countAlternations(alt)).toBe(80);
  });

  test("nested groups", () => {
    expect(
      countAlternations("(a|(b|c))|d"),
    ).toBe(2);
  });
});

describe("classifyPatterns", () => {
  test("string pattern", () => {
    const result = classifyPatterns(["foo|bar"]);
    expect(result[0]!.alternationCount).toBe(2);
    expect(result[0]!.originalIndex).toBe(0);
  });

  test("RegExp pattern", () => {
    const result = classifyPatterns([/a|b|c/]);
    expect(result[0]!.alternationCount).toBe(3);
  });

  test("named pattern", () => {
    const result = classifyPatterns([
      { pattern: "x|y", name: "test" },
    ]);
    expect(result[0]!.alternationCount).toBe(2);
    expect(result[0]!.name).toBe("test");
  });

  test("preserves original indices", () => {
    const result = classifyPatterns([
      "a",
      "b|c",
      "d",
    ]);
    expect(result[0]!.originalIndex).toBe(0);
    expect(result[1]!.originalIndex).toBe(1);
    expect(result[2]!.originalIndex).toBe(2);
  });
});
