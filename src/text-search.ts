import { AhoCorasick } from "@stll/aho-corasick";
import { FuzzySearch } from "@stll/fuzzy-search";
import { RegexSet } from "@stll/regex-set";

import type { ClassifiedPattern } from "./classify";
import { classifyPatterns } from "./classify";
import { mergeAndSelect } from "./merge";
import type {
  Match,
  PatternEntry,
  TextSearchOptions,
} from "./types";

/**
 * An engine instance with pattern index mapping.
 */
type RegexSlot = {
  type: "regex";
  rs: RegexSet;
  indexMap: number[];
  nameMap: (string | undefined)[];
};

type AcSlot = {
  type: "ac";
  ac: AhoCorasick;
  indexMap: number[];
  nameMap: (string | undefined)[];
};

type FuzzySlot = {
  type: "fuzzy";
  fs: FuzzySearch;
  indexMap: number[];
  nameMap: (string | undefined)[];
};

type EngineSlot = RegexSlot | AcSlot | FuzzySlot;

/**
 * Multi-engine text search orchestrator.
 *
 * Routes patterns to the optimal engine
 * configuration:
 * - Large alternation patterns get their own
 *   RegexSet instance (prevents DFA state explosion)
 * - Normal patterns share a single RegexSet
 *   (single-pass multi-pattern DFA)
 *
 * Merges results from all engines into a unified
 * non-overlapping Match[] sorted by position.
 */
export class TextSearch {
  private engines: EngineSlot[] = [];
  private patternCount: number;

  constructor(
    patterns: PatternEntry[],
    options?: TextSearchOptions,
  ) {
    this.patternCount = patterns.length;
    const maxAlt = options?.maxAlternations ?? 50;
    const classified = classifyPatterns(patterns);

    // Four buckets:
    // 1. Fuzzy patterns → FuzzySearch (Levenshtein)
    // 2. Pure literals → Aho-Corasick (SIMD)
    // 3. Normal regex → shared RegexSet (DFA)
    // 4. Large alternations → isolated RegexSet
    const fuzzy: ClassifiedPattern[] = [];
    const literals: ClassifiedPattern[] = [];
    const shared: ClassifiedPattern[] = [];
    const isolated: ClassifiedPattern[] = [];

    for (const cp of classified) {
      if (cp.fuzzyDistance !== undefined) {
        fuzzy.push(cp);
      } else if (cp.isLiteral) {
        literals.push(cp);
      } else if (cp.alternationCount > maxAlt) {
        isolated.push(cp);
      } else {
        shared.push(cp);
      }
    }

    const rsOptions = {
      unicodeBoundaries:
        options?.unicodeBoundaries ?? true,
      wholeWords: options?.wholeWords ?? false,
    };

    // Build fuzzy engine
    if (fuzzy.length > 0) {
      this.engines.push(
        buildFuzzyEngine(fuzzy, {
          unicodeBoundaries:
            rsOptions.unicodeBoundaries,
          wholeWords: rsOptions.wholeWords,
          metric: options?.fuzzyMetric,
          normalizeDiacritics:
            options?.normalizeDiacritics,
          caseInsensitive:
            options?.caseInsensitive,
        }),
      );
    }

    // Build AC engine for pure literals
    if (literals.length > 0) {
      this.engines.push(
        buildAcEngine(literals, rsOptions),
      );
    }

    // Build shared regex engine
    if (shared.length > 0) {
      this.engines.push(
        buildRegexEngine(shared, rsOptions),
      );
    }

    // Build isolated regex engines
    for (const cp of isolated) {
      this.engines.push(
        buildRegexEngine([cp], rsOptions),
      );
    }
  }

  /** Number of patterns. */
  get length(): number {
    return this.patternCount;
  }

  /** Returns true if any pattern matches. */
  isMatch(haystack: string): boolean {
    for (const engine of this.engines) {
      if (engineIsMatch(engine, haystack)) {
        return true;
      }
    }
    return false;
  }

  /** Find all non-overlapping matches. */
  findIter(haystack: string): Match[] {
    if (this.engines.length === 1) {
      return remapMatches(
        engineFindIter(this.engines[0]!, haystack),
        this.engines[0]!,
      );
    }

    const all: Match[] = [];
    for (const engine of this.engines) {
      const matches = engineFindIter(
        engine,
        haystack,
      );
      all.push(...remapMatches(matches, engine));
    }

    return mergeAndSelect(all);
  }

  /** Which pattern indices matched (not where). */
  whichMatch(haystack: string): number[] {
    const seen = new Set<number>();

    for (const engine of this.engines) {
      // AC doesn't have whichMatch — use findIter
      const matches = engineFindIter(
        engine,
        haystack,
      );
      for (const m of matches) {
        seen.add(engine.indexMap[m.pattern]!);
      }
    }

    return [...seen];
  }

  /**
   * Replace all non-overlapping matches.
   * replacements[i] replaces pattern i.
   */
  replaceAll(
    haystack: string,
    replacements: string[],
  ): string {
    if (replacements.length !== this.patternCount) {
      throw new Error(
        `Expected ${this.patternCount} ` +
          `replacements, got ${replacements.length}`,
      );
    }

    const matches = this.findIter(haystack);
    let result = "";
    let last = 0;

    for (const m of matches) {
      result += haystack.slice(last, m.start);
      result += replacements[m.pattern]!;
      last = m.end;
    }

    result += haystack.slice(last);
    return result;
  }
}

/**
 * Build a RegexSet engine from classified patterns.
 */
function buildRegexEngine(
  patterns: ClassifiedPattern[],
  options: {
    unicodeBoundaries: boolean;
    wholeWords: boolean;
  },
): RegexSlot {
  const rsPatterns: (string | RegExp | {
    pattern: string | RegExp;
    name?: string;
  })[] = [];
  const indexMap: number[] = [];
  const nameMap: (string | undefined)[] = [];

  for (const cp of patterns) {
    if (cp.name !== undefined) {
      rsPatterns.push({
        pattern: cp.pattern,
        name: cp.name,
      });
    } else {
      rsPatterns.push(cp.pattern);
    }
    indexMap.push(cp.originalIndex);
    nameMap.push(cp.name);
  }

  const rs = new RegexSet(rsPatterns, options);

  return { type: "regex", rs, indexMap, nameMap };
}

/**
 * Build an Aho-Corasick engine from literal patterns.
 */
function buildAcEngine(
  patterns: ClassifiedPattern[],
  options: {
    unicodeBoundaries: boolean;
    wholeWords: boolean;
  },
): AcSlot {
  const literals: string[] = [];
  const indexMap: number[] = [];
  const nameMap: (string | undefined)[] = [];

  for (const cp of patterns) {
    literals.push(cp.pattern as string);
    indexMap.push(cp.originalIndex);
    nameMap.push(cp.name);
  }

  const ac = new AhoCorasick(literals, {
    wholeWords: options.wholeWords,
  });

  return { type: "ac", ac, indexMap, nameMap };
}

/**
 * Build a FuzzySearch engine from fuzzy patterns.
 */
function buildFuzzyEngine(
  patterns: ClassifiedPattern[],
  options: {
    unicodeBoundaries: boolean;
    wholeWords: boolean;
    metric?: "levenshtein" | "damerau-levenshtein";
    normalizeDiacritics?: boolean;
    caseInsensitive?: boolean;
  },
): FuzzySlot {
  const fsPatterns: {
    pattern: string;
    distance?: number | "auto";
    name?: string;
  }[] = [];
  const indexMap: number[] = [];
  const nameMap: (string | undefined)[] = [];

  for (const cp of patterns) {
    fsPatterns.push({
      pattern: cp.pattern as string,
      distance: cp.fuzzyDistance,
      name: cp.name,
    });
    indexMap.push(cp.originalIndex);
    nameMap.push(cp.name);
  }

  const fs = new FuzzySearch(fsPatterns, {
    unicodeBoundaries: options.unicodeBoundaries,
    wholeWords: options.wholeWords,
    metric: options.metric,
    normalizeDiacritics:
      options.normalizeDiacritics,
    caseInsensitive: options.caseInsensitive,
  });

  return { type: "fuzzy", fs, indexMap, nameMap };
}

/**
 * Dispatch isMatch to the correct engine.
 */
function engineIsMatch(
  engine: EngineSlot,
  haystack: string,
): boolean {
  switch (engine.type) {
    case "ac":
      return engine.ac.isMatch(haystack);
    case "fuzzy":
      return engine.fs.isMatch(haystack);
    case "regex":
      return engine.rs.isMatch(haystack);
  }
}

/**
 * Dispatch findIter to the correct engine.
 */
function engineFindIter(
  engine: EngineSlot,
  haystack: string,
): Match[] {
  switch (engine.type) {
    case "ac":
      return engine.ac.findIter(haystack);
    case "fuzzy":
      return engine.fs.findIter(haystack);
    case "regex":
      return engine.rs.findIter(haystack);
  }
}

/**
 * Remap engine-local match indices to original
 * input indices and add names.
 */
function remapMatches(
  matches: Match[],
  engine: EngineSlot,
): Match[] {
  return matches.map((m) => {
    const originalIdx =
      engine.indexMap[m.pattern]!;
    const name = engine.nameMap[m.pattern];
    const result: Match = {
      pattern: originalIdx,
      start: m.start,
      end: m.end,
      text: m.text,
    };
    if (name !== undefined) {
      result.name = name;
    }
    return result;
  });
}
