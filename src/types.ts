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
   * Case-insensitive matching. Applied to all
   * engines: RegexSet (ASCII via `(?i-u:...)`),
   * Aho-Corasick (ASCII), FuzzySearch (Unicode).
   * @default false
   */
  caseInsensitive?: boolean;
};
