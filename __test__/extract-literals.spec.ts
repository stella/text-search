import { describe, expect, test } from "bun:test";

import { extractLiterals } from "../src/extract-literals";

describe("extractLiterals", () => {
  test("pure literal returns itself", () => {
    const r = extractLiterals("hello world");
    expect(r).not.toBeNull();
    expect(r!.literals).toEqual(["hello world"]);
    expect(r!.mode).toBe("required");
  });

  test("regex with literal prefix", () => {
    const r = extractLiterals(
      "rodné číslo:\\s*\\d{6}/\\d{4}",
    );
    expect(r).not.toBeNull();
    expect(r!.literals).toEqual(["rodné číslo:"]);
    expect(r!.mode).toBe("required");
  });

  test("regex with escaped dot as literal", () => {
    const r = extractLiterals(
      "s\\.r\\.o\\.",
    );
    expect(r).not.toBeNull();
    expect(r!.literals).toEqual(["s.r.o."]);
  });

  test("IČO pattern extracts prefix", () => {
    const r = extractLiterals("IČO:\\s*\\d{8}");
    expect(r).not.toBeNull();
    expect(r!.literals[0]).toBe("IČO:");
  });

  test("top-level alternation", () => {
    const r = extractLiterals("foo|bar|baz");
    expect(r).not.toBeNull();
    expect(r!.literals).toEqual([
      "foo",
      "bar",
      "baz",
    ]);
    expect(r!.mode).toBe("any");
  });

  test("alternation with shared suffix", () => {
    const r = extractLiterals(
      "(?:Ing|Mgr|Dr)\\.\\s+\\w+",
    );
    expect(r).not.toBeNull();
    // Extracts from the group content
  });

  test("no literal returns null", () => {
    const r = extractLiterals("\\d+");
    expect(r).toBeNull();
  });

  test("too short literal returns null", () => {
    const r = extractLiterals("a\\d+");
    expect(r).toBeNull();
  });

  test("alternation with one branchless returns null", () => {
    const r = extractLiterals("foo|\\d+");
    expect(r).toBeNull();
  });

  test("pattern with character class", () => {
    const r = extractLiterals(
      "datum narození[: ]+\\d{1,2}",
    );
    expect(r).not.toBeNull();
    expect(r!.literals[0]).toBe("datum narození");
  });

  test("phone pattern with lookahead", () => {
    const r = extractLiterals(
      "(?<=\\s)\\+420\\s?\\d{3}",
    );
    expect(r).not.toBeNull();
    // Should extract "+420" or part of it
  });

  test("email-like pattern", () => {
    const r = extractLiterals(
      "[a-zA-Z.]+@[a-zA-Z.]+",
    );
    // The @ should be extractable but is only 1 char
    // May return null depending on MIN_LITERAL_LENGTH
  });

  test("DIČ pattern", () => {
    const r = extractLiterals("DIČ:\\s*CZ\\d{8,10}");
    expect(r).not.toBeNull();
    expect(r!.literals[0]).toBe("DIČ:");
  });
});
