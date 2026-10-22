/** Entity engine contract, replaced by upstream type imports with the 1.2.0 dependency bump. */
/** Construction options. All text must already be normalized by the caller. */
export type EntityIndexOptions = {
  forms: number;
  budget: { byLength: number[]; basis: "shorter" };
  initialWeight: number;
  initialSimilarity: number;
};
export type EntityAliasToken = {
  id: number;
  weight: number;
  minimumWeight: number;
};
export type EntityAliasJoin = {
  id: number;
  left: number;
  right: number;
};
export type EntityAliasForm = {
  form: number;
  tokens: EntityAliasToken[];
  joins: EntityAliasJoin[];
  minimumTotal: number;
};
export type EntityAliasInput = {
  entryId: number;
  entityGroup: number;
  quality: number;
  forms: EntityAliasForm[];
};
export type EntityQuery = {
  tokens: { form: number; text: string; weight: number }[];
  units: {
    form: number;
    text: string;
    positions: number[];
  }[];
};
export type EntitySearchParams = {
  /** Candidate bound threshold; final scoring remains caller owned. */
  tau: number;
  quality: number;
  /** Non-negative safe integer. Exhaustion means results may be incomplete. */
  maxCost: number;
};
export type EntitySearchCost = {
  lexiconCells: number;
  lexiconMatches: number;
  sortedAccesses: number;
  randomAccessPairs: number;
  survivors: number;
};
export type EntitySearchResult = {
  /** [unit, form, token id] triples, aligned with similarities. */
  matchKeys: Uint32Array;
  similarities: Float64Array;
  queryWeights: Float64Array;
  /** Surviving alias ids; ids follow builder insertion order. */
  survivors: Uint32Array;
  cost: EntitySearchCost;
  exhausted: boolean;
};

export type EntityIndexEngine = {
  nativeBytes: number;
  postingCount: number;
  toBytes: () => Uint8Array;
  search: (
    query: EntityQuery,
    params: EntitySearchParams,
  ) => EntitySearchResult;
};

export type EntityIndexBuilderEngine = {
  intern: (form: number, text: string) => number;
  addAlias: (alias: EntityAliasInput) => number;
  finish: (tokenWeights: Float64Array[]) => EntityIndexEngine;
  finishAsync: (tokenWeights: Float64Array[]) => Promise<EntityIndexEngine>;
  finishSteps: (
    tokenWeights: Float64Array[],
    maxUnits?: number,
  ) => Generator<void, EntityIndexEngine>;
};
