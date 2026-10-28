/* Browser/WASM entry point — loads @stll/-wasm
 * engines and re-exports the public API. */

import { AhoCorasick } from "@stll/aho-corasick-wasm";
import {
  EntityIndex as EngineEntityIndex,
  EntityIndexBuilder as EngineEntityIndexBuilder,
  FuzzySearch,
} from "@stll/fuzzy-search-wasm";
import { RegexSet } from "@stll/regex-set-wasm";

import { initEngines } from "./engines";

initEngines({
  AhoCorasick,
  FuzzySearch,
  RegexSet,
  EntityIndex: EngineEntityIndex,
  EntityIndexBuilder: EngineEntityIndexBuilder,
});

export { EmptyPatternError, TextSearch } from "./text-search";
export type { Match, PatternEntry, TextSearchOptions } from "./types";

export { EntityIndex, EntityIndexBuilder } from "./entity-index";
export type {
  EntityAliasForm,
  EntityAliasInput,
  EntityAliasJoin,
  EntityAliasToken,
  EntityIndexOptions,
  EntityQuery,
  EntitySearchCost,
  EntitySearchOptions,
  EntitySearchResult,
} from "./entity-index";
