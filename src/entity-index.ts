import { getEngines } from "./engines";
import type {
  EntityAliasInput,
  EntityIndexBuilderEngine,
  EntityIndexEngine,
  EntityIndexOptions,
  EntityQuery,
  EntitySearchResult,
} from "./entity-index-contract";

export type {
  EntityAliasForm,
  EntityAliasInput,
  EntityAliasJoin,
  EntityAliasToken,
  EntityIndexOptions,
  EntityQuery,
  EntitySearchCost,
  EntitySearchResult,
} from "./entity-index-contract";

const BASE_WORK_CAP = 250_000;
const WORK_PER_POSTING = 8;
const THRESHOLD_MARGIN = 1e-9;
const BOOST_ROUNDING_MARGIN = Number.EPSILON;

export type EntitySearchOptions = {
  cutoff: number;
  /** Product of (1 - boost) for every active score boost; 1 means no boosts. */
  boostProduct: number;
  maxCost: number;
};

/** Mutable builder; normalization and token weights are supplied by the caller. */
export class EntityIndexBuilder {
  private inner: EntityIndexBuilderEngine;

  constructor(options: EntityIndexOptions) {
    const { EntityIndexBuilder: Builder } = getEngines();
    this.inner = new Builder(options);
  }

  intern(form: number, text: string): number {
    return this.inner.intern(form, text);
  }

  addAlias(alias: EntityAliasInput): number {
    return this.inner.addAlias(alias);
  }

  finish(tokenWeights: Float64Array[]): EntityIndex {
    return EntityIndex._fromEngine(this.inner.finish(tokenWeights));
  }

  async finishAsync(tokenWeights: Float64Array[]): Promise<EntityIndex> {
    return EntityIndex._fromEngine(await this.inner.finishAsync(tokenWeights));
  }

  *finishSteps(tokenWeights: Float64Array[], maxUnits?: number): Generator<void, EntityIndex> {
    return EntityIndex._fromEngine(yield* this.inner.finishSteps(tokenWeights, maxUnits));
  }
}

/** Immutable candidate index; callers score and rank the returned survivors. */
export class EntityIndex {
  private constructor(private inner: EntityIndexEngine) {}

  /** @internal */
  static _fromEngine(inner: EntityIndexEngine): EntityIndex {
    return new EntityIndex(inner);
  }

  static fromBytes(bytes: Uint8Array): EntityIndex {
    return new EntityIndex(getEngines().EntityIndex.fromBytes(bytes));
  }

  toBytes(): Uint8Array {
    return this.inner.toBytes();
  }

  get nativeBytes(): number {
    return this.inner.nativeBytes;
  }

  get postingCount(): number {
    return this.inner.postingCount;
  }

  get workCap(): number {
    return BASE_WORK_CAP + WORK_PER_POSTING * this.inner.postingCount;
  }

  search(
    query: EntityQuery,
    { cutoff, boostProduct, maxCost }: EntitySearchOptions,
  ): EntitySearchResult {
    if (!Number.isFinite(cutoff) || cutoff < 0 || cutoff > 1) {
      throw new RangeError("cutoff must be finite and between 0 and 1");
    }
    if (!Number.isFinite(boostProduct) || boostProduct < 0 || boostProduct > 1) {
      throw new RangeError("boostProduct must be finite and between 0 and 1");
    }
    if (!Number.isSafeInteger(maxCost) || maxCost < 0) {
      throw new RangeError("maxCost must be a non-negative safe integer");
    }
    // Include forward-score rounding before dividing by a tiny boost product.
    const tau =
      boostProduct === 0
        ? 0
        : Math.max(0, 1 - (1 - cutoff + BOOST_ROUNDING_MARGIN) / boostProduct - THRESHOLD_MARGIN);
    return this.inner.search(query, { tau, quality: 1, maxCost });
  }
}
