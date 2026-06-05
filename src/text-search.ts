import type { ClassifiedPattern } from "./classify";
import { classifyPatterns } from "./classify";
import { getEngines } from "./engines";
import { mergeAndSelect } from "./merge";
import type { Match, PatternEntry, TextSearchOptions } from "./types";

const AUTO_REGEX_CHUNK_MAX_SIZE = 16;
const AUTO_REGEX_CHUNK_COMPLEXITY_BUDGET = 6;
const AUTO_REGEX_ISOLATE_COMPLEXITY = 7;
const SPLIT_IDENTITY_AC_MIN_PATTERNS = 40_000;
const SPLIT_IDENTITY_AC_CHUNK_SIZE = 20_000;

/** Common engine interface for dispatch. */
type Engine = {
  isMatch: (haystack: string) => boolean;
  findIter: (haystack: string) => Match[];
};

type OverlapEngine = Engine & {
  findOverlappingIter: (haystack: string) => Match[];
};

/**
 * An engine instance with pattern index mapping.
 */
type RegexSlot = {
  type: "regex";
  rs?: Engine;
  build?: (() => Engine) | undefined;
  prefilter?: Engine | undefined;
  prefilterRegex?: RegExp | undefined;
  indexMap: number[];
  nameMap: (string | undefined)[];
  identityMap?: true;
};

type AcSlot = {
  type: "ac";
  ac: Engine;
  indexMap: number[];
  nameMap: (string | undefined)[];
  identityMap?: true;
  patternCount?: number;
};

type SplitAcSlot = {
  type: "split-ac";
  acs: {
    ac: OverlapEngine;
    patternOffset: number;
  }[];
  indexMap: number[];
  nameMap: (string | undefined)[];
  identityMap: true;
  patternCount: number;
};

type FuzzySlot = {
  type: "fuzzy";
  fs: Engine;
  indexMap: number[];
  nameMap: (string | undefined)[];
  identityMap?: true;
};

type EngineSlot = RegexSlot | AcSlot | SplitAcSlot | FuzzySlot;

/**
 * Multi-engine text search orchestrator.
 *
 * Routes patterns to the optimal engine
 * configuration:
 * - Large alternation patterns get their own
 *   RegexSet instance (prevents DFA state explosion)
 * - Normal regex patterns use complexity-aware chunks
 *   (avoids bad cross-pattern DFA interaction)
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
    if (patterns.length > 0 && options?.allLiteral === true && allStringPatterns(patterns)) {
      const engine = buildIdentityAcEngine(patterns, {
        unicodeBoundaries: options.unicodeBoundaries ?? true,
        wholeWords: options.wholeWords ?? false,
        caseInsensitive: options.caseInsensitive ?? false,
      });
      this.engines.push(engine);
      this.zeroOverhead = true;
      return;
    }

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
      } else if (cp.regexOptions?.lazy === true) {
        isolated.push(cp);
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

    // Keep normal regex patterns in bounded chunks.
    // One giant RegexSet can develop poor cross-pattern
    // DFA interactions; auto chunking groups simple
    // homogeneous regexes while isolating complex
    // patterns with lookarounds, Unicode classes,
    // large repeats, or long wildcard spans.
    for (const chunk of chunkSharedRegexPatterns(shared, options?.regexChunkSize)) {
      this.engines.push(buildRegexEngine(chunk, rsOptions));
    }

    for (const cp of isolated) {
      const lazyOptions: {
        lazy?: boolean;
        prefilterAny?: readonly string[];
        prefilterCaseInsensitive?: boolean;
        prefilterRegex?: RegExp;
      } = {};
      if (cp.regexOptions?.lazy === true) {
        lazyOptions.lazy = true;
      }
      if (cp.regexOptions?.prefilterAny !== undefined) {
        lazyOptions.prefilterAny = cp.regexOptions.prefilterAny;
      }
      if (cp.regexOptions?.prefilterCaseInsensitive !== undefined) {
        lazyOptions.prefilterCaseInsensitive = cp.regexOptions.prefilterCaseInsensitive;
      }
      if (cp.regexOptions?.prefilterRegex !== undefined) {
        lazyOptions.prefilterRegex = cp.regexOptions.prefilterRegex;
      }
      this.engines.push(buildRegexEngine([cp], rsOptions, lazyOptions));
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
        const idx = getOriginalPatternIndex(engine, m.pattern);
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

function chunkSharedRegexPatterns(
  patterns: ClassifiedPattern[],
  explicitChunkSize: number | undefined,
): ClassifiedPattern[][] {
  if (explicitChunkSize !== undefined) {
    const chunkSize = Math.max(1, explicitChunkSize);
    const chunks: ClassifiedPattern[][] = [];
    for (let i = 0; i < patterns.length; i += chunkSize) {
      chunks.push(patterns.slice(i, i + chunkSize));
    }
    return chunks;
  }

  const chunks: ClassifiedPattern[][] = [];
  let current: ClassifiedPattern[] = [];
  let currentComplexity = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current);
    current = [];
    currentComplexity = 0;
  };

  for (const pattern of patterns) {
    const complexity = pattern.regexComplexity;
    if (complexity >= AUTO_REGEX_ISOLATE_COMPLEXITY) {
      flush();
      chunks.push([pattern]);
      continue;
    }

    const wouldExceedSize = current.length >= AUTO_REGEX_CHUNK_MAX_SIZE;
    const wouldExceedComplexity =
      current.length > 0 && currentComplexity + complexity > AUTO_REGEX_CHUNK_COMPLEXITY_BUDGET;
    if (wouldExceedSize || wouldExceedComplexity) {
      flush();
    }

    current.push(pattern);
    currentComplexity += complexity;
  }

  flush();
  return chunks;
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
  lazyOptions?: {
    lazy?: boolean;
    prefilterAny?: readonly string[];
    prefilterCaseInsensitive?: boolean;
    prefilterRegex?: RegExp;
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
      });
    } else {
      rsPatterns.push(cp.pattern);
    }
    indexMap.push(cp.originalIndex);
    nameMap.push(cp.name);
  }

  const { RegexSet } = getEngines();
  const build = () => new RegexSet(rsPatterns, options);
  const inferredPrefilter =
    lazyOptions === undefined && patterns.length === 1
      ? inferLeadingLiteralPrefilter(patterns[0]?.pattern)
      : undefined;

  if (lazyOptions?.lazy === true) {
    const prefilter =
      lazyOptions.prefilterAny && lazyOptions.prefilterAny.length > 0
        ? buildLiteralPrefilter(lazyOptions.prefilterAny, {
            caseInsensitive: lazyOptions.prefilterCaseInsensitive ?? options.caseInsensitive,
          })
        : undefined;
    const slot: RegexSlot = { type: "regex", build, prefilter, indexMap, nameMap };
    if (lazyOptions.prefilterRegex !== undefined) {
      slot.prefilterRegex = lazyOptions.prefilterRegex;
    }
    return slot;
  }

  if (inferredPrefilter !== undefined) {
    const slot: RegexSlot = { type: "regex", rs: build(), indexMap, nameMap };
    slot.prefilter = buildLiteralPrefilter([inferredPrefilter.literal], {
      caseInsensitive: inferredPrefilter.caseInsensitive || options.caseInsensitive,
    });
    return slot;
  }
  return { type: "regex", rs: build(), indexMap, nameMap };
}

function inferLeadingLiteralPrefilter(
  pattern: string | RegExp | undefined,
): { literal: string; caseInsensitive: boolean } | undefined {
  if (pattern === undefined) {
    return undefined;
  }

  const source = pattern instanceof RegExp ? pattern.source : pattern;
  let caseInsensitive = pattern instanceof RegExp ? pattern.ignoreCase : false;
  let i = 0;

  if (source.startsWith("(?i)")) {
    caseInsensitive = true;
    i = 4;
  }

  while (i < source.length) {
    if (source[i] === "^") {
      i++;
      continue;
    }
    if (source[i] === "\\" && /[bBAZz]/.test(source[i + 1] ?? "")) {
      i += 2;
      continue;
    }
    if (
      source.startsWith("(?=", i) ||
      source.startsWith("(?!", i) ||
      source.startsWith("(?<=", i) ||
      source.startsWith("(?<!", i)
    ) {
      const end = findRegexGroupEnd(source, i);
      if (end === undefined) {
        return undefined;
      }
      i = end;
      continue;
    }
    break;
  }

  let literal = "";
  while (i < source.length) {
    const ch = source[i];
    if (ch === undefined) {
      break;
    }
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === undefined || /[A-Za-z]/.test(next)) {
        break;
      }
      literal += next;
      i += 2;
      continue;
    }
    if ("^$*+?.()[]{}|".includes(ch)) {
      break;
    }
    literal += ch;
    i++;
  }

  if (source[i] === "|") {
    return undefined;
  }
  if (source[i] === "?" || source[i] === "*") {
    literal = literal.slice(0, -1);
  } else if (source[i] === "{" && source.startsWith("{0", i)) {
    literal = literal.slice(0, -1);
  }

  return literal.length >= 2 ? { literal, caseInsensitive } : undefined;
}

function findRegexGroupEnd(source: string, start: number): number | undefined {
  let depth = 0;
  let inClass = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[" && !inClass) {
      inClass = true;
      continue;
    }
    if (ch === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) {
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return undefined;
}

function buildLiteralPrefilter(
  literals: readonly string[],
  options: { caseInsensitive: boolean },
): Engine {
  const unique = [...new Set(literals.filter((literal) => literal.length > 0))];
  if (unique.length === 1) {
    const literal = unique[0];
    if (literal === undefined) {
      throw new Error("Expected single literal after length check");
    }
    const needle = options.caseInsensitive ? literal.toLowerCase() : literal;
    return {
      isMatch: (haystack) =>
        options.caseInsensitive
          ? haystack.toLowerCase().includes(needle)
          : haystack.includes(needle),
      findIter: () => [],
    };
  }

  const { AhoCorasick } = getEngines();
  return new AhoCorasick(unique, {
    caseInsensitive: options.caseInsensitive,
  });
}

function allStringPatterns(patterns: PatternEntry[]): patterns is string[] {
  for (const pattern of patterns) {
    if (typeof pattern !== "string") {
      return false;
    }
  }
  return true;
}

function getRegexSlotEngine(engine: RegexSlot): Engine {
  if (engine.rs !== undefined) {
    return engine.rs;
  }
  if (engine.build === undefined) {
    throw new Error("Lazy regex slot is missing a builder");
  }
  engine.rs = engine.build();
  engine.build = undefined;
  return engine.rs;
}

function regexSlotPrefilterMatches(engine: RegexSlot, haystack: string): boolean {
  if (engine.prefilter && !engine.prefilter.isMatch(haystack)) {
    return false;
  }
  if (engine.prefilterRegex) {
    engine.prefilterRegex.lastIndex = 0;
    if (!engine.prefilterRegex.test(haystack)) {
      return false;
    }
  }
  return true;
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

  return { type: "ac", ac, indexMap, nameMap, patternCount: literals.length };
}

function buildIdentityAcEngine(
  patterns: string[],
  options: {
    unicodeBoundaries: boolean;
    wholeWords: boolean;
    caseInsensitive: boolean;
  },
): AcSlot | SplitAcSlot {
  const { AhoCorasick } = getEngines();
  if (
    options.wholeWords &&
    options.unicodeBoundaries &&
    patterns.length >= SPLIT_IDENTITY_AC_MIN_PATTERNS
  ) {
    const acs: SplitAcSlot["acs"] = [];
    for (let i = 0; i < patterns.length; i += SPLIT_IDENTITY_AC_CHUNK_SIZE) {
      acs.push({
        ac: new AhoCorasick(patterns.slice(i, i + SPLIT_IDENTITY_AC_CHUNK_SIZE), {
          wholeWords: options.wholeWords,
          unicodeBoundaries: options.unicodeBoundaries,
          caseInsensitive: options.caseInsensitive,
        }) as OverlapEngine,
        patternOffset: i,
      });
    }

    return {
      type: "split-ac",
      acs,
      indexMap: [],
      nameMap: [],
      identityMap: true,
      patternCount: patterns.length,
    };
  }

  const ac = new AhoCorasick(patterns, {
    wholeWords: options.wholeWords,
    unicodeBoundaries: options.unicodeBoundaries,
    caseInsensitive: options.caseInsensitive,
  });

  return {
    type: "ac",
    ac,
    indexMap: [],
    nameMap: [],
    identityMap: true,
    patternCount: patterns.length,
  };
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

  const fsOptions: {
    unicodeBoundaries: boolean;
    wholeWords: boolean;
    metric?: "levenshtein" | "damerau-levenshtein";
    normalizeDiacritics?: boolean;
    caseInsensitive?: boolean;
  } = {
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
    case "split-ac":
      return engine.acs.some(({ ac }) => ac.isMatch(haystack));
    case "fuzzy":
      return engine.fs.isMatch(haystack);
    case "regex":
      if (!regexSlotPrefilterMatches(engine, haystack)) {
        return false;
      }
      return getRegexSlotEngine(engine).isMatch(haystack);
  }
  throw new Error("Unsupported engine type");
}

/**
 * Dispatch findIter to the correct engine.
 */
function engineFindIter(engine: EngineSlot, haystack: string): Match[] {
  switch (engine.type) {
    case "ac":
      return engine.ac.findIter(haystack);
    case "split-ac":
      return splitAcFindIter(engine, haystack);
    case "fuzzy":
      return engine.fs.findIter(haystack);
    case "regex":
      if (!regexSlotPrefilterMatches(engine, haystack)) {
        return [];
      }
      return getRegexSlotEngine(engine).findIter(haystack);
  }
  throw new Error("Unsupported engine type");
}

function splitAcFindIter(engine: SplitAcSlot, haystack: string): Match[] {
  const all: Match[] = [];
  for (const { ac, patternOffset } of engine.acs) {
    const matches = ac.findOverlappingIter(haystack);
    for (const match of matches) {
      all.push({
        pattern: match.pattern + patternOffset,
        start: match.start,
        end: match.end,
        text: match.text,
      });
    }
  }
  return selectLeftmostLongestMatches(all);
}

function selectLeftmostLongestMatches(matches: Match[]): Match[] {
  if (matches.length === 0) {
    return [];
  }

  matches.sort((a, b) => a.start - b.start || b.end - a.end || a.pattern - b.pattern);

  const selected: Match[] = [];
  let cursor = 0;
  let i = 0;
  while (i < matches.length) {
    const start = matches[i]?.start;
    if (start === undefined) {
      break;
    }
    if (start < cursor) {
      i++;
      continue;
    }

    let best = matches[i];
    if (best === undefined) {
      break;
    }
    i++;
    while (i < matches.length && matches[i]?.start === start) {
      const candidate = matches[i];
      if (
        candidate !== undefined &&
        (candidate.end > best.end ||
          (candidate.end === best.end && candidate.pattern < best.pattern))
      ) {
        best = candidate;
      }
      i++;
    }

    selected.push(best);
    cursor = best.end;
  }

  return selected;
}

/**
 * Remap engine-local match indices to original
 * input indices and add names.
 */
function remapMatches(matches: Match[], engine: EngineSlot): Match[] {
  return matches.map((m) => {
    const originalIdx = getOriginalPatternIndex(engine, m.pattern);
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
    if (m.distance !== undefined) {
      result.distance = m.distance;
    }
    return result;
  });
}

function getOriginalPatternIndex(engine: EngineSlot, pattern: number): number {
  if (engine.identityMap === true) {
    return pattern;
  }
  const originalIdx = engine.indexMap[pattern];
  if (originalIdx === undefined) {
    throw new Error(`Missing indexMap entry for pattern ${pattern}`);
  }
  return originalIdx;
}
