/**
 * Extract required literal substrings from regex
 * patterns. Used by the Hyperscan-inspired pre-filter
 * to determine which regions of text need regex
 * validation.
 *
 * A "required literal" is a substring that MUST appear
 * in the haystack for the regex to match. If the
 * literal is absent, the regex cannot match.
 */

/**
 * Result of literal extraction from a regex pattern.
 */
export type ExtractedLiterals = {
  /**
   * Required literal strings. If this is a single
   * string, it must appear. If multiple (from
   * alternation), at least one must appear.
   */
  literals: string[];
  /**
   * Whether this is an alternation (any-of) or a
   * required (all must appear) set. For pre-filtering,
   * "any" means we add all to AC and trigger regex
   * when any one matches.
   */
  mode: "required" | "any";
  /**
   * Byte offset of the literal within the original
   * pattern (approximate, for margin calculation).
   */
  offset: number;
};

/**
 * Minimum useful literal length. Single characters
 * are too common to be effective filters.
 */
const MIN_LITERAL_LENGTH = 2;

/**
 * Regex metacharacters that break a literal run.
 */
const METACHAR = new Set([
  "\\",
  ".",
  "^",
  "$",
  "*",
  "+",
  "?",
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  "|",
]);

/**
 * Extract required literals from a regex pattern
 * string. Returns null if no useful literal can be
 * extracted.
 *
 * Strategy: walk the pattern character by character,
 * accumulate literal runs, flush on metacharacter.
 * Keep the longest run as the required literal.
 *
 * For alternations at the top level (`foo|bar`),
 * extract literals from each branch and return them
 * as "any" mode.
 */
export function extractLiterals(
  pattern: string,
): ExtractedLiterals | null {
  // Handle RegExp objects — extract source
  const source =
    pattern instanceof RegExp
      ? (pattern as RegExp).source
      : pattern;

  // First check: is this a top-level alternation?
  const topBranches = splitTopLevel(source);
  if (topBranches.length > 1) {
    return extractFromAlternation(topBranches);
  }

  // Single pattern: find the longest literal run
  const result = findLongestLiteral(source);
  if (
    result === null ||
    result.literal.length < MIN_LITERAL_LENGTH
  ) {
    return null;
  }

  return {
    literals: [result.literal],
    mode: "required",
    offset: result.offset,
  };
}

/**
 * Split a pattern at top-level alternation pipes.
 * Respects grouping depth and character classes.
 */
function splitTopLevel(pattern: string): string[] {
  const branches: string[] = [];
  let depth = 0;
  let inClass = false;
  let start = 0;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;

    if (ch === "\\" && i + 1 < pattern.length) {
      i++; // skip escaped char
      continue;
    }

    if (ch === "[") inClass = true;
    if (ch === "]") inClass = false;

    if (!inClass) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "|" && depth === 0) {
        branches.push(pattern.slice(start, i));
        start = i + 1;
      }
    }
  }

  branches.push(pattern.slice(start));
  return branches;
}

/**
 * Extract literals from alternation branches.
 * Each branch must have a useful literal for the
 * pre-filter to work.
 */
function extractFromAlternation(
  branches: string[],
): ExtractedLiterals | null {
  const literals: string[] = [];

  for (const branch of branches) {
    const result = findLongestLiteral(branch);
    if (
      result === null ||
      result.literal.length < MIN_LITERAL_LENGTH
    ) {
      // One branch has no literal — pre-filter
      // can't reject, so it's useless
      return null;
    }
    literals.push(result.literal);
  }

  return {
    literals,
    mode: "any",
    offset: 0,
  };
}

/**
 * Find the longest literal run in a pattern string.
 * Handles escape sequences (e.g., `\\.` is literal dot,
 * `\\d` is not literal).
 */
function findLongestLiteral(
  pattern: string,
): { literal: string; offset: number } | null {
  let best = "";
  let bestOffset = 0;
  let current = "";
  let currentOffset = 0;
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i]!;

    if (ch === "\\") {
      // Escape sequence
      if (i + 1 >= pattern.length) break;
      const next = pattern[i + 1]!;

      // Literal escapes: \., \(, \), etc.
      if (isEscapedLiteral(next)) {
        if (current.length === 0) currentOffset = i;
        current += next;
        i += 2;
        continue;
      }

      // Non-literal escape (\d, \w, \s, \b, etc.)
      flushRun();
      i += 2;
      continue;
    }

    if (METACHAR.has(ch)) {
      flushRun();

      // Skip character class contents
      if (ch === "[") {
        i = skipCharClass(pattern, i);
        continue;
      }

      // Skip group markers
      if (ch === "(") {
        // Skip (?:, (?=, (?<=, etc.
        if (
          i + 1 < pattern.length &&
          pattern[i + 1] === "?"
        ) {
          i += 2;
          while (
            i < pattern.length &&
            pattern[i] !== ")" &&
            pattern[i] !== ":"
          ) {
            i++;
          }
          if (
            i < pattern.length &&
            pattern[i] === ":"
          ) {
            i++; // skip the colon
          }
          continue;
        }
        i++;
        continue;
      }

      // Skip quantifiers
      if (ch === "{") {
        i = skipQuantifier(pattern, i);
        continue;
      }

      i++;
      continue;
    }

    // Regular literal character
    if (current.length === 0) currentOffset = i;
    current += ch;
    i++;
  }

  flushRun();

  if (best.length < MIN_LITERAL_LENGTH) return null;
  return { literal: best, offset: bestOffset };

  function flushRun(): void {
    if (current.length > best.length) {
      best = current;
      bestOffset = currentOffset;
    }
    current = "";
  }
}

/**
 * Check if an escaped character produces a literal.
 * E.g., `\.` is literal dot, `\d` is a char class.
 */
function isEscapedLiteral(ch: string): boolean {
  // These escape sequences are NOT literals
  // (they represent character classes or assertions)
  const nonLiteral = new Set([
    "d",
    "D",
    "w",
    "W",
    "s",
    "S",
    "b",
    "B",
    "A",
    "z",
    "Z",
    "p",
    "P",
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "n",
    "r",
    "t",
    "f",
    "v",
    "x",
    "u",
    "k",
  ]);
  return !nonLiteral.has(ch);
}

/**
 * Skip past a character class `[...]`.
 * Returns the index after the closing `]`.
 */
function skipCharClass(
  pattern: string,
  start: number,
): number {
  let i = start + 1;
  // Handle negation and leading ]
  if (i < pattern.length && pattern[i] === "^") i++;
  if (i < pattern.length && pattern[i] === "]") i++;

  while (i < pattern.length) {
    if (
      pattern[i] === "\\" &&
      i + 1 < pattern.length
    ) {
      i += 2;
      continue;
    }
    if (pattern[i] === "]") return i + 1;
    i++;
  }
  return i;
}

/**
 * Skip past a quantifier `{n,m}`.
 * Returns the index after the closing `}`.
 */
function skipQuantifier(
  pattern: string,
  start: number,
): number {
  let i = start + 1;
  while (i < pattern.length && pattern[i] !== "}") {
    i++;
  }
  return i + 1;
}
