/**
 * A single match result. Same shape as
 * @stll/regex-set and @stll/aho-corasick.
 */
export type Match = {
  /** Index of the pattern that matched. */
  pattern: number;
  /** Start UTF-16 code unit offset. */
  start: number;
  /** End offset (exclusive). */
  end: number;
  /** The matched text. */
  text: string;
  /** Pattern name (if provided). */
  name?: string;
  /** Edit distance (fuzzy matches only). */
  distance?: number;
};

/** A pattern entry for TextSearch. */
export type PatternEntry =
  | string
  | RegExp
  | {
      pattern: string | RegExp;
      name?: string;
    }
  | {
      pattern: string;
      name?: string;
      /** Fuzzy matching distance. Routes to
       *  @stll/fuzzy-search instead of regex. */
      distance: number | "auto";
    }
  | {
      pattern: string;
      name?: string;
      /** Force literal matching via Aho-Corasick.
       *  Skips regex metacharacter detection so
       *  patterns like "č.p." or "s.r.o." are
       *  matched literally, not as regex. */
      literal: true;
      /** Per-pattern case-insensitive for AC.
       *  Overrides the global option for this
       *  pattern only. */
      caseInsensitive?: boolean;
      /** Per-pattern whole-word matching for AC. */
      wholeWords?: boolean;
    };

/** Options for TextSearch. */
export type TextSearchOptions = {
  /**
   * Use Unicode word boundaries.
   * @default true
   */
  unicodeBoundaries?: boolean;

  /**
   * Only match whole words.
   * @default false
   */
  wholeWords?: boolean;

  /**
   * Max alternation branches before auto-splitting
   * into a separate engine instance. Prevents DFA
   * state explosion when large-alternation patterns
   * are combined with other patterns.
   * @default 50
   */
  maxAlternations?: number;

  /**
   * Fuzzy matching metric.
   * @default "levenshtein"
   */
  fuzzyMetric?: "levenshtein" | "damerau-levenshtein";

  /**
   * Normalize diacritics for fuzzy matching.
   * @default false
   */
  normalizeDiacritics?: boolean;

  /**
   * Case-insensitive matching for AC literals
   * and fuzzy patterns.
   * @default false
   */
  caseInsensitive?: boolean;

  /**
   * How to handle overlapping matches from
   * different engines or patterns.
   *
   * - "longest": keep longest non-overlapping match
   *   at each position (default).
   * - "all": return all matches including overlaps.
   *   Useful when the caller applies its own dedup.
   *
   * @default "longest"
   */
  overlapStrategy?: "longest" | "all";

  /**
   * Treat ALL string patterns as literals (route
   * to AC, skip metacharacter detection). Useful
   * for deny-list patterns where "s.r.o." means
   * the literal string, not a regex with wildcards.
   * @default false
   */
  allLiteral?: boolean;
};
