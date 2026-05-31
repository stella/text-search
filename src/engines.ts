/**
 * Late-bound engine registry.
 *
 * Native and WASM entry points call initEngines()
 * with their respective implementations before any
 * TextSearch instance is created.
 */

import type {
  Options as AhoOptions,
  PatternEntry as AhoPatternEntry,
} from "@stll/aho-corasick";
import type {
  Options as FuzzyOptions,
  PatternEntry as FuzzyPatternEntry,
} from "@stll/fuzzy-search";
import type {
  Options as RegexOptions,
  PatternEntry as RegexPatternEntry,
} from "@stll/regex-set";
import type { Match } from "./types";

type Engine = {
  isMatch: (haystack: string) => boolean;
  findIter: (haystack: string) => Match[];
};

type Engines = {
  AhoCorasick: new (
    patterns: AhoPatternEntry[],
    options?: AhoOptions,
  ) => Engine;
  FuzzySearch: new (
    patterns: FuzzyPatternEntry[],
    options?: FuzzyOptions,
  ) => Engine;
  RegexSet: new (
    patterns: RegexPatternEntry[],
    options?: RegexOptions,
  ) => Engine;
};

let engines: Engines | undefined;

export const initEngines = (e: Engines): void => {
  engines = e;
};

export const getEngines = (): Engines => {
  if (!engines) {
    throw new Error(
      "Engines not initialized. Import from " +
        "@stll/text-search or @stll/text-search-wasm, " +
        "not from internal modules.",
    );
  }
  return engines;
};
