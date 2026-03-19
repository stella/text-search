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
};

/** A pattern entry for TextSearch. */
export type PatternEntry =
  | string
  | RegExp
  | {
      pattern: string | RegExp;
      name?: string;
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
};
