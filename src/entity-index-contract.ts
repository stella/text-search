import type { EntityIndex, EntityIndexBuilder } from "@stll/fuzzy-search";

export type {
  EntityAliasForm,
  EntityAliasInput,
  EntityAliasJoin,
  EntityAliasToken,
  EntityIndexOptions,
  EntityQuery,
  EntitySearchCost,
  EntitySearchParams,
  EntitySearchResult,
} from "@stll/fuzzy-search";

/** Structural engine surface shared by the native and browser backends. */
export type EntityIndexEngine = Pick<EntityIndex, keyof EntityIndex>;
export type EntityIndexBuilderEngine = Pick<
  EntityIndexBuilder,
  "intern" | "addAlias"
> & {
  finish: (
    ...args: Parameters<EntityIndexBuilder["finish"]>
  ) => EntityIndexEngine;
  finishAsync: (
    ...args: Parameters<EntityIndexBuilder["finishAsync"]>
  ) => Promise<EntityIndexEngine>;
  finishSteps: (
    ...args: Parameters<EntityIndexBuilder["finishSteps"]>
  ) => Generator<void, EntityIndexEngine>;
};
