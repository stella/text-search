import { describe, expect, test } from "bun:test";

import { mergeAndSelect } from "../src/merge";
import type { Match } from "../src/types";

const m = (
  pattern: number,
  start: number,
  end: number,
): Match => ({
  pattern,
  start,
  end,
  text: "x".repeat(end - start),
});

describe("mergeAndSelect", () => {
  test("empty", () => {
    expect(mergeAndSelect([])).toEqual([]);
  });

  test("single match", () => {
    const matches = [m(0, 0, 3)];
    expect(mergeAndSelect(matches)).toEqual([
      m(0, 0, 3),
    ]);
  });

  test("non-overlapping preserved", () => {
    const matches = [m(0, 0, 3), m(1, 5, 8)];
    const result = mergeAndSelect(matches);
    expect(result).toHaveLength(2);
  });

  test("overlapping: longest wins", () => {
    const matches = [
      m(0, 0, 3),
      m(1, 0, 5), // longer at same position
    ];
    const result = mergeAndSelect(matches);
    expect(result).toHaveLength(1);
    expect(result[0]!.end).toBe(5);
  });

  test("sorts by position", () => {
    const matches = [m(1, 5, 8), m(0, 0, 3)];
    const result = mergeAndSelect(matches);
    expect(result[0]!.start).toBe(0);
    expect(result[1]!.start).toBe(5);
  });

  test("greedy non-overlapping", () => {
    const matches = [
      m(0, 0, 5),
      m(1, 3, 8), // overlaps with first
      m(2, 6, 10),
    ];
    const result = mergeAndSelect(matches);
    expect(result).toHaveLength(2);
    expect(result[0]!.pattern).toBe(0);
    expect(result[1]!.pattern).toBe(2);
  });
});
