/* Native entry point — loads @stll engines
 * for Node.js/Bun and re-exports the public API. */

import { AhoCorasick } from "@stll/aho-corasick";
import {
  EntityIndex as EngineEntityIndex,
  EntityIndexBuilder as EngineEntityIndexBuilder,
  FuzzySearch,
} from "@stll/fuzzy-search";
import { RegexSet } from "@stll/regex-set";

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
