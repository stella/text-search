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
  /**
   * Fuzzy distance if this is a fuzzy pattern.
   * Routes to @stll/fuzzy-search.
   */
  fuzzyDistance?: number | "auto";
  /**
   * Per-pattern AC options. When set, this literal
   * is grouped with others that have the same
   * options into a separate AC engine instance.
   */
  acOptions?: {
    caseInsensitive?: boolean;
    wholeWords?: boolean;
  };
};

/**
 * Check if a string is a pure literal (no regex
 * metacharacters). Pure literals are routed to
 * Aho-Corasick instead of the regex DFA.
 */
export function isLiteralPattern(
  pattern: string,
): boolean {
  // All standard regex metacharacters cause a
  // pattern to be classified as regex (→ RegexSet).
  // To force literal AC routing for patterns with
  // dots/parens (e.g., "s.r.o.", "č.p."), use the
  // explicit { literal: true } PatternEntry flag.
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
 * Count the maximum alternation branches at any
 * depth in a regex string. Used to detect patterns
 * with large alternations (even nested inside
 * groups) that should be isolated into their own
 * RegexSet to prevent DFA state explosion.
 *
 * "a|b|c" → 3
 * "(a|b)|c" → 2 (max of top=2, depth1=2)
 * "(?:Ing\\.|Mgr\\.|Dr\\.)" → 3 (depth 1)
 */
export function countAlternations(
  pattern: string,
): number {
  let depth = 0;
  let inClass = false;
  let i = 0;

  // Track max alternation count seen at any depth.
  // Each time we enter a group, start a fresh count.
  // When we leave, update the global max.
  let max = 1;
  let currentCount = 1; // count for current group
  const stack: number[] = []; // saved counts

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "\\" && i + 1 < pattern.length) {
      i += 2;
      continue;
    }

    if (ch === "[") inClass = true;
    if (ch === "]") inClass = false;

    if (!inClass) {
      if (ch === "(") {
        stack.push(currentCount);
        currentCount = 1;
        depth++;
      }
      if (ch === ")") {
        if (currentCount > max) max = currentCount;
        currentCount = stack.pop() ?? 1;
        depth--;
      }
      if (ch === "|") {
        currentCount++;
      }
    }

    i++;
  }
  // Check top-level count too
  if (currentCount > max) max = currentCount;
  return max;
}

/**
 * Classify and normalize pattern entries.
 */
export function classifyPatterns(
  entries: PatternEntry[],
  allLiteral = false,
): ClassifiedPattern[] {
  return entries.map((entry, i) => {
    if (typeof entry === "string") {
      return {
        originalIndex: i,
        pattern: entry,
        alternationCount: allLiteral
          ? 0
          : countAlternations(entry),
        isLiteral: allLiteral ||
          isLiteralPattern(entry),
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

    // Fuzzy pattern: has `distance` field
    if ("distance" in entry) {
      return {
        originalIndex: i,
        pattern: entry.pattern,
        name: entry.name,
        alternationCount: 0,
        isLiteral: false,
        fuzzyDistance: entry.distance,
      };
    }

    // Explicit literal: skip metachar detection
    if ("literal" in entry && entry.literal) {
      const hasPerPatternOpts =
        "caseInsensitive" in entry ||
        "wholeWords" in entry;
      return {
        originalIndex: i,
        pattern: entry.pattern,
        name: entry.name,
        alternationCount: 0,
        isLiteral: true,
        acOptions: hasPerPatternOpts
          ? {
              caseInsensitive:
                entry.caseInsensitive,
              wholeWords: entry.wholeWords,
            }
          : undefined,
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
