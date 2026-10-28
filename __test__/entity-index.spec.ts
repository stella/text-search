import { afterEach, describe, expect, mock, test } from "bun:test";

import { EntityIndex, EntityIndexBuilder } from "../src";
import { getEngines, initEngines } from "../src/engines";
import type {
  EntityAliasInput,
  EntityIndexBuilderEngine,
  EntityIndexEngine,
  EntityIndexOptions,
  EntityQuery,
  EntitySearchParams,
  EntitySearchResult,
} from "../src/entity-index-contract";

const registeredEngines = getEngines();
afterEach(() => initEngines(registeredEngines));

const options = {
  forms: 1,
  budget: { byLength: [0, 0, 1], basis: "shorter" },
  initialWeight: 0.5,
  initialSimilarity: 0.8,
} satisfies EntityIndexOptions;
const alias = {
  entryId: 42,
  entityGroup: 7,
  quality: 1,
  forms: [
    {
      form: 0,
      tokens: [{ id: 3, weight: 1, minimumWeight: 1 }],
      joins: [],
      minimumTotal: 1,
    },
  ],
} satisfies EntityAliasInput;
const query = {
  tokens: [{ form: 0, text: "alpha", weight: 1 }],
  units: [{ form: 0, text: "alpha", positions: [0] }],
} satisfies EntityQuery;
const packedResult = {
  matchKeys: new Uint32Array([0, 0, 3]),
  similarities: new Float64Array([1]),
  queryWeights: new Float64Array([1]),
  survivors: new Uint32Array([0]),
  cost: {
    lexiconCells: 5,
    lexiconMatches: 1,
    sortedAccesses: 1,
    randomAccessPairs: 1,
    survivors: 1,
  },
  exhausted: false,
} satisfies EntitySearchResult;

const installFake = () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const search = mock(
    (_query: EntityQuery, _params: EntitySearchParams) => packedResult,
  );
  const engine = {
    nativeBytes: 128,
    postingCount: 17,
    toBytes: mock(() => bytes),
    search,
  } satisfies EntityIndexEngine;
  const construct = mock((_options: EntityIndexOptions) => {});
  const intern = mock((_form: number, _text: string) => 3);
  const addAlias = mock((_alias: EntityAliasInput) => 0);
  const finish = mock((_weights: Float64Array[]) => engine);
  const finishAsync = mock(async (_weights: Float64Array[]) => engine);
  const stepCalls = mock((_weights: Float64Array[], _maxUnits?: number) => {});
  class Builder implements EntityIndexBuilderEngine {
    constructor(builderOptions: EntityIndexOptions) {
      construct(builderOptions);
    }
    intern = intern;
    addAlias = addAlias;
    finish = finish;
    finishAsync = finishAsync;
    *finishSteps(weights: Float64Array[], maxUnits?: number) {
      stepCalls(weights, maxUnits);
      yield;
      yield;
      return engine;
    }
  }
  const fromBytes = mock((_bytes: Uint8Array) => engine);
  initEngines({
    ...registeredEngines,
    EntityIndexBuilder: Builder,
    EntityIndex: { fromBytes },
  });
  return {
    bytes,
    search,
    construct,
    intern,
    addAlias,
    finish,
    finishAsync,
    stepCalls,
    fromBytes,
  };
};

const expectWrappedIndex = (index: EntityIndex, bytes: Uint8Array) => {
  expect(index).toBeInstanceOf(EntityIndex);
  expect(index.toBytes()).toBe(bytes);
  expect(index.nativeBytes).toBe(128);
  expect(index.postingCount).toBe(17);
  expect(index.workCap).toBe(250_000 + 8 * 17);
};

describe("EntityIndex facade", () => {
  test("registered entity engine rejects invalid serialized indices", () => {
    expect(() => EntityIndex.fromBytes(new Uint8Array())).toThrow();
  });

  test("builder forwards construction, intern, aliases and synchronous completion", () => {
    const fake = installFake();
    const builder = new EntityIndexBuilder(options);
    expect(fake.construct.mock.calls.at(0)?.at(0)).toBe(options);
    expect(builder.intern(0, "alpha")).toBe(3);
    expect(fake.intern).toHaveBeenCalledWith(0, "alpha");
    expect(builder.addAlias(alias)).toBe(0);
    expect(fake.addAlias.mock.calls.at(0)?.at(0)).toBe(alias);
    const weights = [new Float64Array([1])];
    expectWrappedIndex(builder.finish(weights), fake.bytes);
    expect(fake.finish.mock.calls.at(0)?.at(0)).toBe(weights);
  });

  test("asynchronous completion wraps the engine result", async () => {
    const fake = installFake();
    const weights = [new Float64Array([1])];
    expectWrappedIndex(
      await new EntityIndexBuilder(options).finishAsync(weights),
      fake.bytes,
    );
    expect(fake.finishAsync.mock.calls.at(0)?.at(0)).toBe(weights);
  });

  test.each([undefined, 23])(
    "stepped completion preserves yields and result, maxUnits=%s",
    (maxUnits) => {
      const fake = installFake();
      const weights = [new Float64Array([1])];
      const steps = new EntityIndexBuilder(options).finishSteps(
        weights,
        maxUnits,
      );
      expect(steps.next()).toEqual({ value: undefined, done: false });
      expect(steps.next()).toEqual({ value: undefined, done: false });
      const final = steps.next();
      expect(final.done).toBe(true);
      if (!final.done) throw new Error("Expected completed generator");
      expectWrappedIndex(final.value, fake.bytes);
      expect(fake.stepCalls.mock.calls.at(0)?.[0]).toBe(weights);
      expect(fake.stepCalls.mock.calls.at(0)?.[1]).toBe(maxUnits);
    },
  );

  test("deserialization and packed search results preserve identity", () => {
    const fake = installFake();
    const bytes = new Uint8Array([9, 8]);
    const index = EntityIndex.fromBytes(bytes);
    expect(fake.fromBytes.mock.calls.at(0)?.at(0)).toBe(bytes);
    expectWrappedIndex(index, fake.bytes);
    expect(
      index.search(query, { cutoff: 0.8, boostProduct: 0.5, maxCost: 123 }),
    ).toBe(packedResult);
    expect(fake.search.mock.calls.at(0)?.[0]).toBe(query);
    expect(fake.search.mock.calls.at(0)?.[1]).toMatchObject({
      quality: 1,
      maxCost: 123,
    });
    expect(fake.search.mock.calls.at(0)?.[1].tau).toBeCloseTo(0.6 - 1e-9, 12);
  });

  test("inverse boost threshold never prunes a qualifying base score", () => {
    const fake = installFake();
    const index = EntityIndex.fromBytes(fake.bytes);
    for (const cutoff of [0, 0.1, 0.5, 0.8, 1]) {
      for (const boostProduct of [
        0,
        Number.MIN_VALUE,
        1e-20,
        1e-10,
        0.1,
        0.5,
        1,
      ]) {
        index.search(query, {
          cutoff,
          boostProduct,
          maxCost: Number.MAX_SAFE_INTEGER,
        });
        const params = fake.search.mock.lastCall?.[1];
        if (params === undefined)
          throw new Error("Expected forwarded search parameters");
        expect(params.quality).toBe(1);
        expect(params.maxCost).toBe(Number.MAX_SAFE_INTEGER);
        expect(Number.isFinite(params.tau)).toBe(true);
        expect(params.tau).toBeGreaterThanOrEqual(0);
        expect(params.tau).toBeLessThanOrEqual(1);
        if (boostProduct === 0 || cutoff === 0) expect(params.tau).toBe(0);
        if (boostProduct === 1)
          expect(params.tau).toBeCloseTo(Math.max(0, cutoff - 1e-9), 12);
        for (const baseScore of [0, 0.1, 0.5, 0.6, 0.8, 1]) {
          const boostedScore = 1 - (1 - baseScore) * boostProduct;
          if (boostedScore >= cutoff)
            expect(baseScore).toBeGreaterThanOrEqual(params.tau);
        }
      }
    }
  });

  test.each([0, Number.MAX_SAFE_INTEGER])(
    "valid work ceiling reaches the engine: %s",
    (maxCost) => {
      const fake = installFake();
      EntityIndex.fromBytes(fake.bytes).search(query, {
        cutoff: 0,
        boostProduct: 1,
        maxCost,
      });
      expect(fake.search).toHaveBeenCalledWith(query, {
        tau: 0,
        quality: 1,
        maxCost,
      });
    },
  );

  test("rounded boosts at cutoff one conservatively retain all base scores", () => {
    const fake = installFake();
    EntityIndex.fromBytes(fake.bytes).search(query, {
      cutoff: 1,
      boostProduct: Number.MIN_VALUE,
      maxCost: 0,
    });
    expect(1 - Number.MIN_VALUE).toBe(1);
    expect(fake.search.mock.lastCall?.[1]).toEqual({
      tau: 0,
      quality: 1,
      maxCost: 0,
    });
  });

  test.each([
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    -0.01,
    1.01,
  ])(
    "invalid threshold inputs fail before reaching the engine: %s",
    (invalid) => {
      const fake = installFake();
      const index = EntityIndex.fromBytes(fake.bytes);
      expect(() =>
        index.search(query, { cutoff: invalid, boostProduct: 1, maxCost: 0 }),
      ).toThrow(RangeError);
      expect(() =>
        index.search(query, { cutoff: 0.5, boostProduct: invalid, maxCost: 0 }),
      ).toThrow(RangeError);
      expect(fake.search).not.toHaveBeenCalled();
    },
  );

  test.each([
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])("invalid work ceiling fails before reaching the engine: %s", (maxCost) => {
    const fake = installFake();
    const index = EntityIndex.fromBytes(fake.bytes);
    expect(() =>
      index.search(query, { cutoff: 0.5, boostProduct: 1, maxCost }),
    ).toThrow(RangeError);
    expect(fake.search).not.toHaveBeenCalled();
  });
});

test("published entity engines preserve candidates across construction modes and serialization", async () => {
  for (const mode of ["sync", "async", "steps"] as const) {
    const builder = new EntityIndexBuilder(options);
    const id = builder.intern(0, "alpha");
    const expectedAlias = builder.addAlias({
      ...alias,
      forms: [
        {
          form: 0,
          tokens: [{ id, weight: 1, minimumWeight: 1 }],
          joins: [],
          minimumTotal: 1,
        },
      ],
    });
    const weights = [new Float64Array([1])];
    const index = await (async () => {
      switch (mode) {
        case "sync":
          return builder.finish(weights);
        case "async":
          return builder.finishAsync(weights);
        case "steps": {
          const iterator = builder.finishSteps(weights, 1);
          let step = iterator.next();
          while (!step.done) step = iterator.next();
          return step.value;
        }
      }
    })();
    for (const candidate of [index, EntityIndex.fromBytes(index.toBytes())]) {
      const result = candidate.search(query, {
        cutoff: 0.9,
        boostProduct: 1,
        maxCost: candidate.workCap,
      });
      expect(result.exhausted).toBe(false);
      expect([...result.survivors]).toEqual([expectedAlias]);
      expect([...result.matchKeys]).toEqual([0, 0, id]);
      expect([...result.similarities]).toEqual([1]);
    }
  }
});
