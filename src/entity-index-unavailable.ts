/** Temporary engine until the entity API is available in the dependency. */
import type { EntityIndexOptions } from "./entity-index-contract";

const unavailable = (): never => {
  throw new Error("EntityIndex requires @stll/fuzzy-search >= 1.2.0");
};

export class UnavailableEntityIndexBuilder {
  constructor(_options: EntityIndexOptions) {
    unavailable();
  }
  intern = unavailable;
  addAlias = unavailable;
  finish = unavailable;
  finishAsync = unavailable;
  finishSteps = unavailable;
}

export const UnavailableEntityIndex = { fromBytes: unavailable };
