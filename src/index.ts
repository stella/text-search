/* Native entry point — loads @stll engines
 * for Node.js/Bun and re-exports the public API. */

import { AhoCorasick } from "@stll/aho-corasick";
import { FuzzySearch } from "@stll/fuzzy-search";
import { RegexSet } from "@stll/regex-set";

import { initEngines } from "./engines";
import { UnavailableEntityIndex, UnavailableEntityIndexBuilder } from "./entity-index-unavailable";

initEngines({
  AhoCorasick,
  FuzzySearch,
  RegexSet,
  EntityIndex: UnavailableEntityIndex,
  EntityIndexBuilder: UnavailableEntityIndexBuilder,
});

export { TextSearch } from "./text-search";
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
