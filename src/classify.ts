import type { PatternEntry } from "./types";

/**
 * Normalized pattern with metadata for routing.
 */
export type ClassifiedPattern = {
  /** Original index in the input array. */
  originalIndex: number;
  /** The regex-compatible pattern string. */
  pattern: string | RegExp;
  /** Optional name. */
  name?: string;
  /**
   * Number of top-level alternation branches.
   * Used to detect large alternations that should
   * be isolated into their own RegexSet instance.
   */
  alternationCount: number;
};

/**
 * Count top-level alternation branches in a regex
 * string. Tracks parenthesis depth to avoid counting
 * alternations inside groups.
 *
 * "a|b|c" → 3
 * "(a|b)|c" → 2 (inner | is inside group)
 * "(?:Ing\\.|Mgr\\.|Dr\\.)" → 1 (all inside group)
 */
export function countAlternations(
  pattern: string,
): number {
  let depth = 0;
  let count = 1;
  let inClass = false;
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    // Skip escaped characters
    if (ch === "\\" && i + 1 < pattern.length) {
      i += 2;
      continue;
    }

    if (ch === "[") inClass = true;
    if (ch === "]") inClass = false;

    if (!inClass) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "|" && depth === 0) count++;
    }

    i++;
  }

  return count;
}

/**
 * Classify and normalize pattern entries.
 */
export function classifyPatterns(
  entries: PatternEntry[],
): ClassifiedPattern[] {
  return entries.map((entry, i) => {
    if (typeof entry === "string") {
      return {
        originalIndex: i,
        pattern: entry,
        alternationCount: countAlternations(entry),
      };
    }

    if (entry instanceof RegExp) {
      return {
        originalIndex: i,
        pattern: entry,
        alternationCount: countAlternations(
          entry.source,
        ),
      };
    }

    const pat = entry.pattern;
    const source =
      pat instanceof RegExp ? pat.source : pat;

    return {
      originalIndex: i,
      pattern: pat,
      name: entry.name,
      alternationCount:
        countAlternations(source),
    };
  });
}
