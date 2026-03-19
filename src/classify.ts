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
  /**
   * True if the pattern is a pure literal string
   * (no regex metacharacters). These can be routed
   * to Aho-Corasick for SIMD-accelerated matching.
   */
  isLiteral: boolean;
};

/**
 * Check if a string is a pure literal (no regex
 * metacharacters). Pure literals are routed to
 * Aho-Corasick instead of the regex DFA.
 */
export function isLiteralPattern(
  pattern: string,
): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (
      ch === "\\" ||
      ch === "." ||
      ch === "^" ||
      ch === "$" ||
      ch === "*" ||
      ch === "+" ||
      ch === "?" ||
      ch === "{" ||
      ch === "}" ||
      ch === "(" ||
      ch === ")" ||
      ch === "[" ||
      ch === "]" ||
      ch === "|"
    ) {
      return false;
    }
  }
  return pattern.length > 0;
}

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
        isLiteral: isLiteralPattern(entry),
      };
    }

    if (entry instanceof RegExp) {
      return {
        originalIndex: i,
        pattern: entry,
        alternationCount: countAlternations(
          entry.source,
        ),
        isLiteral: false, // RegExp is never literal
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
      isLiteral:
        typeof pat === "string" &&
        isLiteralPattern(pat),
    };
  });
}
