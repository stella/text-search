// Runs the packed @stll/text-search-wasm package, with the engine packages it
// depends on, in the browser and writes the outcome into #out for check.mjs.
const out = document.getElementById("out");

const assertEqual = (label, actual, expected) => {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
};

const buildEntityIndex = (EntityIndexBuilder) => {
  const builder = new EntityIndexBuilder({
    forms: 1,
    budget: { byLength: [0, 0, 0, 0, 1, 1, 2], basis: "shorter" },
    initialWeight: 1,
    initialSimilarity: 0.8,
  });
  for (const [entryId, text] of ["Novák", "Příbram"].entries()) {
    const id = builder.intern(0, text);
    builder.addAlias({
      entryId,
      entityGroup: entryId,
      quality: 1,
      forms: [
        {
          form: 0,
          tokens: [{ id, weight: 1, minimumWeight: 1 }],
          joins: [],
          minimumTotal: 1,
        },
      ],
    });
  }
  return builder;
};

// Load each engine on its own first, so a failure names the engine package.
const engines = {};
for (const [name, load] of [
  ["@stll/aho-corasick-wasm", () => import("@stll/aho-corasick-wasm")],
  ["@stll/fuzzy-search-wasm", () => import("@stll/fuzzy-search-wasm")],
  ["@stll/regex-set-wasm", () => import("@stll/regex-set-wasm")],
]) {
  try {
    await load();
    engines[name] = "ok";
  } catch (error) {
    engines[name] = String(error);
  }
}

try {
  if (Object.values(engines).some((status) => status !== "ok")) {
    throw new Error(
      `engine packages failed to load: ${JSON.stringify(engines)}`,
    );
  }
  const { EntityIndexBuilder, TextSearch } =
    await import("@stll/text-search-wasm");

  // One pattern per engine: Aho-Corasick, RegexSet and FuzzySearch.
  const search = new TextSearch([
    { pattern: "s.r.o.", literal: true, name: "company-type" },
    /\b\d{2}\.\d{2}\.\d{4}\b/,
    { pattern: "Novák", distance: 1, name: "surname" },
    String.raw`(?:Ing\.|Mgr\.)\s+[A-Z][a-z]+`,
  ]);
  const haystack = "Ing. Jan Novak, s.r.o., narozen 15.03.1990.";
  const found = search.findIter(haystack);
  for (const match of found) {
    assertEqual(
      "match offsets",
      haystack.slice(match.start, match.end),
      match.text,
    );
  }
  const matches = found
    .toSorted((left, right) => left.start - right.start)
    .map(({ pattern, text, name }) => ({ pattern, text, name }));
  assertEqual("findIter", matches, [
    { pattern: 3, text: "Ing. Jan" },
    { pattern: 2, text: "Novak", name: "surname" },
    { pattern: 0, text: "s.r.o.", name: "company-type" },
    { pattern: 1, text: "15.03.1990" },
  ]);

  // finishAsync builds on the fuzzy-search worker pool.
  const weights = () => [new Float64Array(2).fill(1)];
  const syncIndex = buildEntityIndex(EntityIndexBuilder).finish(weights());
  const asyncIndex =
    await buildEntityIndex(EntityIndexBuilder).finishAsync(weights());
  const syncBytes = [...syncIndex.toBytes()];
  assertEqual("finishAsync bytes", [...asyncIndex.toBytes()], syncBytes);

  out.textContent = JSON.stringify({
    ok: true,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    matches,
    entityIndexBytes: syncBytes.length,
  });
} catch (error) {
  out.textContent = JSON.stringify({
    ok: false,
    error: String(error?.stack ?? error),
  });
}
