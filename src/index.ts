/* Native entry point — loads @stll engines
 * for Node.js/Bun and re-exports the public API. */

import { AhoCorasick } from "@stll/aho-corasick";
import { FuzzySearch } from "@stll/fuzzy-search";
import { RegexSet } from "@stll/regex-set";

import { initEngines } from "./engines";

initEngines({ AhoCorasick, FuzzySearch, RegexSet });

export { TextSearch } from "./text-search";
export type { Match, PatternEntry, TextSearchOptions } from "./types";
