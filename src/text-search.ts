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
 * An engine instance: a RegexSet with its pattern
 * index mapping back to the original input array.
 */
type EngineSlot = {
  rs: RegexSet;
  /** Maps engine-local index → original index. */
  indexMap: number[];
  /** Maps engine-local index → name. */
  nameMap: (string | undefined)[];
};

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

    // Split: large alternations get isolated engines,
    // normal patterns share one engine.
    const shared: ClassifiedPattern[] = [];
    const isolated: ClassifiedPattern[] = [];

    for (const cp of classified) {
      if (cp.alternationCount > maxAlt) {
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

    // Build shared engine (if any normal patterns)
    if (shared.length > 0) {
      this.engines.push(
        buildEngine(shared, rsOptions),
      );
    }

    // Build isolated engines (one per large pattern)
    for (const cp of isolated) {
      this.engines.push(
        buildEngine([cp], rsOptions),
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
      if (engine.rs.isMatch(haystack)) {
        return true;
      }
    }
    return false;
  }

  /** Find all non-overlapping matches. */
  findIter(haystack: string): Match[] {
    if (this.engines.length === 1) {
      // Fast path: single engine, no merge needed
      return remapMatches(
        this.engines[0]!.rs.findIter(haystack),
        this.engines[0]!,
      );
    }

    // Collect from all engines
    const all: Match[] = [];
    for (const engine of this.engines) {
      const matches = engine.rs.findIter(haystack);
      all.push(...remapMatches(matches, engine));
    }

    return mergeAndSelect(all);
  }

  /** Which pattern indices matched (not where). */
  whichMatch(haystack: string): number[] {
    const seen = new Set<number>();

    for (const engine of this.engines) {
      const which = engine.rs.whichMatch(haystack);
      for (const localIdx of which) {
        seen.add(engine.indexMap[localIdx]!);
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
function buildEngine(
  patterns: ClassifiedPattern[],
  options: {
    unicodeBoundaries: boolean;
    wholeWords: boolean;
  },
): EngineSlot {
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

  return { rs, indexMap, nameMap };
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
