import type { ClassifiedPattern } from "./classify";
import { classifyPatterns } from "./classify";
import { getEngines } from "./engines";
import { mergeAndSelect } from "./merge";
import type { Match, PatternEntry, TextSearchOptions } from "./types";

/** Common engine interface for dispatch. */
type Engine = {
  isMatch: (haystack: string) => boolean;
  findIter: (haystack: string) => Match[];
};

/**
 * An engine instance with pattern index mapping.
 */
type RegexSlot = {
  type: "regex";
  rs: Engine;
  indexMap: number[];
  nameMap: (string | undefined)[];
};

type AcSlot = {
  type: "ac";
  ac: Engine;
  indexMap: number[];
  nameMap: (string | undefined)[];
};

type FuzzySlot = {
  type: "fuzzy";
  fs: Engine;
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
  private overlapAll: boolean;
  /**
   * True when there's exactly one engine and all
   * patterns map to identity indices (0→0, 1→1, ...).
   * Enables zero-overhead findIter: return raw engine
   * output without remapping or object allocation.
   */
  private zeroOverhead: boolean = false;

  constructor(patterns: PatternEntry[], options?: TextSearchOptions) {
    this.patternCount = patterns.length;
    this.overlapAll = options?.overlapStrategy === "all";
    const maxAlt = options?.maxAlternations ?? 50;
    const classified = classifyPatterns(patterns, options?.allLiteral ?? false);

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
      unicodeBoundaries: options?.unicodeBoundaries ?? true,
      wholeWords: options?.wholeWords ?? false,
      caseInsensitive: options?.caseInsensitive ?? false,
    };

    // Build fuzzy engine
    if (fuzzy.length > 0) {
      const fuzzyOpts: Parameters<typeof buildFuzzyEngine>[1] = {
        unicodeBoundaries: rsOptions.unicodeBoundaries,
        wholeWords: rsOptions.wholeWords,
      };
      if (options?.fuzzyMetric !== undefined) fuzzyOpts.metric = options.fuzzyMetric;
      if (options?.normalizeDiacritics !== undefined)
        fuzzyOpts.normalizeDiacritics = options.normalizeDiacritics;
      if (options?.caseInsensitive !== undefined)
        fuzzyOpts.caseInsensitive = options.caseInsensitive;
      this.engines.push(buildFuzzyEngine(fuzzy, fuzzyOpts));
    }

    // Build AC engine(s) for pure literals.
    // Group by per-pattern AC options so patterns
    // with different caseInsensitive/wholeWords
    // settings get separate AC instances.
    if (literals.length > 0) {
      const groups = new Map<string, ClassifiedPattern[]>();
      for (const cp of literals) {
        const ci = cp.acOptions?.caseInsensitive ?? rsOptions.caseInsensitive;
        const ww = cp.acOptions?.wholeWords ?? rsOptions.wholeWords;
        const key = `${ci ? 1 : 0}:${ww ? 1 : 0}`;
        const group = groups.get(key);
        if (group) {
          group.push(cp);
        } else {
          groups.set(key, [cp]);
        }
      }
      for (const [key, group] of groups) {
        const [ci, ww] = key.split(":");
        this.engines.push(
          buildAcEngine(group, {
            ...rsOptions,
            caseInsensitive: ci === "1",
            wholeWords: ww === "1",
          }),
        );
      }
    }

    // Adaptive regex grouping: try combining shared
    // patterns, measure actual search time on a
    // probe string. If combined is slower than
    // individual, fall back to isolation.
    if (shared.length > 1) {
      const combined = buildRegexEngine(shared, rsOptions);
      // Probe: 1KB of mixed content
      const probe = (
        "Hello World 123 test@example.com " +
        "2025-01-01 +420 123 456 789 " +
        "Ing. Jan Novák, s.r.o. Praha 1 "
      ).repeat(10);
      const t0 = performance.now();
      combined.rs.findIter(probe);
      const combinedMs = performance.now() - t0;

      // Individual baseline (sum of isolated scans)
      let individualMs = 0;
      const individualEngines: RegexSlot[] = [];
      for (const cp of shared) {
        const eng = buildRegexEngine([cp], rsOptions);
        const t1 = performance.now();
        eng.rs.findIter(probe);
        individualMs += performance.now() - t1;
        individualEngines.push(eng);
      }

      if (combinedMs > individualMs * 1.5) {
        // Combined is >1.5x slower — isolate
        for (const eng of individualEngines) {
          this.engines.push(eng);
        }
      } else {
        this.engines.push(combined);
      }
    } else if (shared.length === 1) {
      this.engines.push(buildRegexEngine(shared, rsOptions));
    }

    for (const cp of isolated) {
      this.engines.push(buildRegexEngine([cp], rsOptions));
    }

    // Zero-overhead fast path: when all patterns
    // land in a single engine, the indexMap is
    // identity (0→0, 1→1, ...) and no names need
    // attaching. findIter can return raw engine
    // output without any JS-side remapping.
    if (this.engines.length === 1) {
      const engine = this.engines[0];
      if (engine === undefined) {
        throw new Error("Expected single engine after length check");
      }
      const hasNames = engine.nameMap.some((n) => n !== undefined);
      if (!hasNames) {
        this.zeroOverhead = true;
      }
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

  /**
   * Find matches in text.
   *
   * With `overlapStrategy: "longest"` (default):
   * returns non-overlapping matches, longest wins.
   *
   * With `overlapStrategy: "all"`: returns all
   * matches including overlaps, sorted by position.
   */
  findIter(haystack: string): Match[] {
    // Fast path: single engine, identity indexMap,
    // no names → return raw engine output directly.
    // Zero JS overhead: no remapping, no allocation.
    if (this.zeroOverhead) {
      const engine = this.engines[0];
      if (engine === undefined) {
        throw new Error("Zero-overhead path requires a single engine");
      }
      return engineFindIter(engine, haystack);
    }

    // Single engine but needs name remapping
    if (this.engines.length === 1) {
      const engine = this.engines[0];
      if (engine === undefined) {
        throw new Error("Expected single engine after length check");
      }
      return remapMatches(engineFindIter(engine, haystack), engine);
    }

    // Multi-engine: collect from all, remap in-place
    const all: Match[] = [];
    for (const engine of this.engines) {
      const matches = engineFindIter(engine, haystack);
      // In-place remapping avoids .map() allocation
      for (const m of remapMatches(matches, engine)) {
        all.push(m);
      }
    }

    if (this.overlapAll) {
      return all.sort((a, b) => a.start - b.start);
    }

    return mergeAndSelect(all);
  }

  /** Which pattern indices matched (not where). */
  whichMatch(haystack: string): number[] {
    const seen = new Set<number>();

    for (const engine of this.engines) {
      // AC doesn't have whichMatch — use findIter
      const matches = engineFindIter(engine, haystack);
      for (const m of matches) {
        const idx = engine.indexMap[m.pattern];
        if (idx === undefined) {
          throw new Error(`Missing indexMap entry for pattern ${m.pattern}`);
        }
        seen.add(idx);
      }
    }

    return [...seen];
  }

  /**
   * Replace all non-overlapping matches.
   * replacements[i] replaces pattern i.
   */
  replaceAll(haystack: string, replacements: string[]): string {
    if (replacements.length !== this.patternCount) {
      throw new Error(
        `Expected ${this.patternCount} ` + `replacements, got ${replacements.length}`,
      );
    }

    // Always use non-overlapping matches for
    // replacement, even if overlapStrategy is "all".
    const all: Match[] = [];
    for (const engine of this.engines) {
      const matches = engineFindIter(engine, haystack);
      for (const m of remapMatches(matches, engine)) {
        all.push(m);
      }
    }
    const matches = mergeAndSelect(all);

    let result = "";
    let last = 0;

    for (const m of matches) {
      result += haystack.slice(last, m.start);
      const replacement = replacements[m.pattern];
      if (replacement === undefined) {
        throw new Error(`Missing replacement for pattern ${m.pattern}`);
      }
      result += replacement;
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
    caseInsensitive: boolean;
  },
): RegexSlot {
  const rsPatterns: (
    | string
    | RegExp
    | {
        pattern: string | RegExp;
        name?: string;
      }
  )[] = [];
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

  const { RegexSet } = getEngines();
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
    caseInsensitive: boolean;
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

  const { AhoCorasick } = getEngines();
  const ac = new AhoCorasick(literals, {
    wholeWords: options.wholeWords,
    unicodeBoundaries: options.unicodeBoundaries,
    caseInsensitive: options.caseInsensitive,
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
    const entry: (typeof fsPatterns)[number] = {
      pattern: cp.pattern as string,
    };
    if (cp.fuzzyDistance !== undefined) entry.distance = cp.fuzzyDistance;
    if (cp.name !== undefined) entry.name = cp.name;
    fsPatterns.push(entry);
    indexMap.push(cp.originalIndex);
    nameMap.push(cp.name);
  }

  const fsOptions: Record<string, unknown> = {
    unicodeBoundaries: options.unicodeBoundaries,
    wholeWords: options.wholeWords,
  };
  if (options.metric !== undefined) fsOptions.metric = options.metric;
  if (options.normalizeDiacritics !== undefined)
    fsOptions.normalizeDiacritics = options.normalizeDiacritics;
  if (options.caseInsensitive !== undefined) fsOptions.caseInsensitive = options.caseInsensitive;
  const { FuzzySearch } = getEngines();
  const fs = new FuzzySearch(fsPatterns, fsOptions);

  return { type: "fuzzy", fs, indexMap, nameMap };
}

/**
 * Dispatch isMatch to the correct engine.
 */
function engineIsMatch(engine: EngineSlot, haystack: string): boolean {
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
function engineFindIter(engine: EngineSlot, haystack: string): Match[] {
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
function remapMatches(matches: Match[], engine: EngineSlot): Match[] {
  return matches.map((m) => {
    const originalIdx = engine.indexMap[m.pattern];
    if (originalIdx === undefined) {
      throw new Error(`Missing indexMap entry for pattern ${m.pattern}`);
    }
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
    // Preserve edit distance from fuzzy matches
    if ("distance" in m && m.distance !== undefined) {
      result.distance = m.distance as number;
    }
    return result;
  });
}
