/* Browser/WASM entry point — loads @stll/-wasm
 * engines and re-exports the public API. */

import { AhoCorasick } from "@stll/aho-corasick-wasm";
import { FuzzySearch } from "@stll/fuzzy-search-wasm";
import { RegexSet } from "@stll/regex-set-wasm";

import { initEngines } from "./engines";

initEngines({ AhoCorasick, FuzzySearch, RegexSet });

export { TextSearch } from "./text-search";
export type { Match, PatternEntry, TextSearchOptions } from "./types";
