/**
 * Hyperscan-inspired AC pre-filter for regex patterns.
 *
 * Extracts required literals from regex patterns, builds
 * an AC automaton, and uses it to identify candidate
 * regions before running the regex engine. Only the
 * regions where AC found a required literal are passed
 * to RegexSet for validation.
 *
 * Patterns with no extractable literal fall back to
 * full-text RegexSet scan (same as current behavior).
 */

import { AhoCorasick } from "@stll/aho-corasick";
import { RegexSet } from "@stll/regex-set";

import type { ExtractedLiterals } from "./extract-literals";
import { extractLiterals } from "./extract-literals";
import type { Match } from "./types";

/**
 * Default margin (chars) around an AC hit for regex
 * validation. Must be large enough to cover the full
 * match, including prefix/suffix around the literal.
 */
const DEFAULT_MARGIN = 128;

/**
 * Mapping from AC pattern index to the regex patterns
 * that require that literal.
 */
type LiteralMapping = {
  /** AC pattern index → regex pattern indices. */
  acToRegex: Map<number, number[]>;
  /** Regex pattern index → original input index. */
  regexToOriginal: number[];
  /** Extracted info per regex pattern. */
  extractions: (ExtractedLiterals | null)[];
};

/**
 * A prefiltered regex engine. Combines AC pre-filter
 * with RegexSet validation on candidate regions.
 */
export class PrefilteredEngine {
  /** AC for literal pre-filtering. */
  private ac: AhoCorasick | null = null;
  /** RegexSet for patterns WITH extractable literals
   *  (validated on candidate regions only). */
  private filteredRs: RegexSet | null = null;
  /** RegexSet for patterns WITHOUT extractable literals
   *  (scanned on full text, fallback). */
  private fallbackRs: RegexSet | null = null;
  /** Mapping from AC hits to regex patterns. */
  private mapping: LiteralMapping;
  /** Index maps for result remapping. */
  private filteredIndexMap: number[] = [];
  private fallbackIndexMap: number[] = [];
  /** Pattern names. */
  private nameMap: (string | undefined)[];
  /** Total pattern count. */
  readonly patternCount: number;
  /** Margin around AC hits for regex validation. */
  private margin: number;

  constructor(
    patterns: {
      pattern: string | RegExp;
      originalIndex: number;
      name?: string;
    }[],
    options: {
      unicodeBoundaries: boolean;
      wholeWords: boolean;
      caseInsensitive: boolean;
      margin?: number;
    },
  ) {
    this.patternCount = patterns.length;
    this.margin = options.margin ?? DEFAULT_MARGIN;
    this.nameMap = patterns.map((p) => p.name);

    // Extract literals from each regex pattern
    const extractions = patterns.map((p) => {
      const source =
        p.pattern instanceof RegExp
          ? p.pattern.source
          : p.pattern;
      return extractLiterals(source);
    });

    // Split into filtered (has literals) and
    // fallback (no literals)
    const acPatterns: string[] = [];
    const acToRegex = new Map<number, number[]>();
    const filteredPatterns: {
      pattern: string | RegExp;
      idx: number;
    }[] = [];
    const fallbackPatterns: {
      pattern: string | RegExp;
      idx: number;
    }[] = [];

    for (let i = 0; i < patterns.length; i++) {
      const extraction = extractions[i] ?? null;

      if (extraction !== null) {
        // Has extractable literal(s)
        const patIdx = filteredPatterns.length;
        filteredPatterns.push({
          pattern: patterns[i]!.pattern,
          idx: patterns[i]!.originalIndex,
        });

        // Add literals to AC and build mapping
        for (const lit of extraction.literals) {
          const acIdx = acPatterns.indexOf(lit);
          if (acIdx >= 0) {
            // Reuse existing AC pattern
            acToRegex.get(acIdx)!.push(patIdx);
          } else {
            // New AC pattern
            const newIdx = acPatterns.length;
            acPatterns.push(lit);
            acToRegex.set(newIdx, [patIdx]);
          }
        }
      } else {
        // No literal — fallback to full scan
        fallbackPatterns.push({
          pattern: patterns[i]!.pattern,
          idx: patterns[i]!.originalIndex,
        });
      }
    }

    this.mapping = {
      acToRegex,
      regexToOriginal: patterns.map(
        (p) => p.originalIndex,
      ),
      extractions,
    };

    // Build AC automaton for pre-filtering
    if (acPatterns.length > 0) {
      this.ac = new AhoCorasick(acPatterns, {
        caseInsensitive: options.caseInsensitive,
      });
    }

    // Build RegexSet for filtered patterns
    if (filteredPatterns.length > 0) {
      const rsOpts = {
        unicodeBoundaries: options.unicodeBoundaries,
        wholeWords: options.wholeWords,
        caseInsensitive: options.caseInsensitive,
      };
      this.filteredRs = new RegexSet(
        filteredPatterns.map((p) => p.pattern),
        rsOpts,
      );
      this.filteredIndexMap = filteredPatterns.map(
        (p) => p.idx,
      );
    }

    // Build RegexSet for fallback patterns
    if (fallbackPatterns.length > 0) {
      const rsOpts = {
        unicodeBoundaries: options.unicodeBoundaries,
        wholeWords: options.wholeWords,
        caseInsensitive: options.caseInsensitive,
      };
      this.fallbackRs = new RegexSet(
        fallbackPatterns.map((p) => p.pattern),
        rsOpts,
      );
      this.fallbackIndexMap = fallbackPatterns.map(
        (p) => p.idx,
      );
    }
  }

  /**
   * Check if any pattern matches (fast path).
   */
  isMatch(haystack: string): boolean {
    // Check filtered patterns via pre-filter
    if (this.ac !== null && this.filteredRs !== null) {
      if (this.ac.isMatch(haystack)) {
        // AC found at least one literal — check full
        // regex on the relevant regions. For isMatch,
        // we can just check the full text since we
        // already know a literal is present.
        if (this.filteredRs.isMatch(haystack)) {
          return true;
        }
      }
    }

    // Check fallback patterns (full scan)
    if (this.fallbackRs !== null) {
      if (this.fallbackRs.isMatch(haystack)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Find all matches using prefiltered approach.
   *
   * Phase 1: AC scans full text for required literals.
   * Phase 2: RegexSet validates candidate regions only.
   * Fallback: patterns without literals scan full text.
   */
  findIter(haystack: string): Match[] {
    const results: Match[] = [];

    // Phase 1+2: prefiltered regex matches
    if (this.ac !== null && this.filteredRs !== null) {
      const acHits = this.ac.findIter(haystack);

      if (acHits.length > 0) {
        // Collect candidate regions from AC hits
        const regions = this.buildCandidateRegions(
          acHits,
          haystack.length,
        );

        // Run regex on each merged region
        for (const [rStart, rEnd] of regions) {
          const region = haystack.slice(rStart, rEnd);
          const regionMatches =
            this.filteredRs.findIter(region);

          for (const m of regionMatches) {
            results.push({
              pattern:
                this.filteredIndexMap[m.pattern]!,
              start: m.start + rStart,
              end: m.end + rStart,
              text: m.text,
            });
          }
        }
      }
    }

    // Fallback: patterns without extractable literals
    if (this.fallbackRs !== null) {
      const fallbackMatches =
        this.fallbackRs.findIter(haystack);
      for (const m of fallbackMatches) {
        results.push({
          pattern:
            this.fallbackIndexMap[m.pattern]!,
          start: m.start,
          end: m.end,
          text: m.text,
        });
      }
    }

    // Sort by position
    if (results.length > 1) {
      results.sort((a, b) => a.start - b.start);
    }

    // Add names
    for (const m of results) {
      const name = this.nameMap[m.pattern];
      if (name !== undefined) {
        m.name = name;
      }
    }

    return results;
  }

  /**
   * Build merged candidate regions from AC hits.
   * Expands each hit by ±margin, then merges
   * overlapping regions.
   */
  private buildCandidateRegions(
    acHits: Match[],
    textLength: number,
  ): [number, number][] {
    if (acHits.length === 0) return [];

    // Expand each AC hit to a region
    const expanded: [number, number][] = acHits.map(
      (hit) => [
        Math.max(0, hit.start - this.margin),
        Math.min(textLength, hit.end + this.margin),
      ],
    );

    // Sort by start position
    expanded.sort((a, b) => a[0] - b[0]);

    // Merge overlapping regions
    const merged: [number, number][] = [expanded[0]!];

    for (let i = 1; i < expanded.length; i++) {
      const last = merged[merged.length - 1]!;
      const current = expanded[i]!;

      if (current[0] <= last[1]) {
        // Overlapping — extend
        last[1] = Math.max(last[1], current[1]);
      } else {
        merged.push(current);
      }
    }

    return merged;
  }
}
