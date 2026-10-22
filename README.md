<p align="center">
  <img src=".github/assets/banner.png" alt="Stella" width="100%" />
</p>

# @stll/text-search

Multi-engine text search orchestrator for Node.js
and Bun. It classifies each pattern once, routes
literals to Aho-Corasick, regex to RegexSet, fuzzy
entries to FuzzySearch, and merges the results into
one stable match stream.

Part of the
[@stll text search ecosystem](https://github.com/stella):
[@stll/regex-set](https://github.com/stella/regex-set),
[@stll/aho-corasick](https://github.com/stella/aho-corasick),
[@stll/fuzzy-search](https://github.com/stella/fuzzy-search).

## Install

Node.js / Bun:

```bash
npm install @stll/text-search
# or
bun add @stll/text-search
```

`@stll/text-search` ships the engine packages as
regular dependencies. You do not install them
separately unless you want to use the lower-level
engine APIs directly.

Browser / WebAssembly:

```bash
npm install @stll/text-search-wasm
# or
bun add @stll/text-search-wasm
```

## Vite

`@stll/text-search-wasm` depends on the browser
variants of the Stella engines. Import the bundled
Vite plugin so those WASM loaders stay out of
pre-bundling and keep their relative asset paths.

```ts
import stllTextSearchWasm from "@stll/text-search-wasm/vite";

export default {
  plugins: [stllTextSearchWasm()],
};
```

## Usage

```ts
import { TextSearch } from "@stll/text-search";

const search = new TextSearch([
  "Confidential",
  "Attorney-Client Privilege",
  /\b\d{2}\.\d{2}\.\d{4}\b/,
  /\b[\w.+-]+@[\w-]+\.[\w]+\b/,
  { pattern: "Novák", distance: 1, name: "person" },
  { pattern: "s.r.o.", literal: true, name: "company-type" },
]);

const matches = search.findIter("Ing. Jan Novak, s.r.o., born 15.03.1990.");
```

## Routing model

Patterns are classified once at construction time.

| Engine       | Used for                                           |
| ------------ | -------------------------------------------------- |
| Aho-Corasick | Pure literals and explicit `literal: true` entries |
| RegexSet     | Standard regex patterns                            |
| FuzzySearch  | Entries with a `distance` field                    |

Large alternation-heavy regexes are isolated into
their own RegexSet instance so they do not poison
the shared DFA for simpler patterns.

## Entity candidate index

`EntityIndexBuilder` and `EntityIndex` provide candidate retrieval over
caller-normalized tokens and aliases. They are exported by both entry points.
The current dependency uses a temporary typed stub: construction and
deserialization throw `EntityIndex requires @stll/fuzzy-search >= 1.2.0`.
The native and WASM entity engines will be connected with the 1.2.0 dependency
update.

```ts
import { EntityIndex, EntityIndexBuilder } from "@stll/text-search";

const builder = new EntityIndexBuilder({
  forms: 1,
  budget: { byLength: [0, 0, 0, 0, 1, 1, 2], basis: "shorter" },
  initialWeight: 1,
  initialSimilarity: 0.8,
});
const id = builder.intern(0, "example");
builder.addAlias({
  entryId: 0,
  entityGroup: 0,
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
const index = builder.finish([new Float64Array([1])]);
const restored = EntityIndex.fromBytes(index.toBytes());
const result = restored.search(
  {
    tokens: [{ form: 0, text: "example", weight: 1 }],
    units: [{ form: 0, text: "example", positions: [0] }],
  },
  { cutoff: 0.8, boostProduct: 1, maxCost: restored.workCap },
);
```

`finishAsync(weights)` builds on the native worker pool.
`finishSteps(weights, maxUnits)` returns a generator that yields between bounded
construction steps and returns the completed index. Finishing consumes the
builder. Token weights are supplied as one `Float64Array` per spelling form.

`boostProduct` is the product of `(1 - boost)` across active score boosts;
use `1` without boosts. Search conservatively inverts these boosts before
retrieval. Results contain packed `matchKeys` (unit, form, token ID triples),
aligned `similarities`, `queryWeights`, surviving alias IDs, deterministic
`cost` counters, and `exhausted`. Exhausted results may be incomplete. Callers
perform final scoring and ranking.

`nativeBytes` reports engine memory; `postingCount` reports the posting count.
`workCap` is `250_000 + 8 * postingCount`.

## Rust core

The repository also contains `stella-text-search-core`
in `crates/core`. It mirrors the orchestration layer:
classification, engine routing, regex chunking, lazy
prefilters, split literal search, match merging, and
replacement. The crate is not published yet; it exists
as the native core boundary for downstream bindings.

## Options

```ts
new TextSearch(patterns, {
  unicodeBoundaries: true,
  wholeWords: false,
  maxAlternations: 50,
  fuzzyMetric: "levenshtein",
  normalizeDiacritics: false,
  caseInsensitive: false,
  overlapStrategy: "longest",
  allLiteral: false,
});
```

The default `overlapStrategy: "longest"` selects literal candidates once,
globally, after all engine routes have reported their matches. With `"all"`,
every literal occurrence is retained and ordered by start offset, end offset,
then pattern index. Regex and fuzzy engines expose native non-overlapping
iteration, so `"all"` cannot add overlaps those engines do not report.

## API

| Method                           | Returns    | Description                   |
| -------------------------------- | ---------- | ----------------------------- |
| `findIter(text)`                 | `Match[]`  | Find matches in input text    |
| `isMatch(text)`                  | `boolean`  | Fast yes/no check             |
| `whichMatch(text)`               | `number[]` | Pattern indices that matched  |
| `replaceAll(text, replacements)` | `string`   | Replace matched ranges        |
| `length`                         | `number`   | Number of configured patterns |

## Pattern entry types

```ts
"literal"
/\bregex\b/i
{ pattern: "\\d+", name: "number" }
{ pattern: "Novák", distance: 1, name: "person" }
{ pattern: "s.r.o.", literal: true, wholeWords: true }
```

## Match shape

```ts
type Match = {
  pattern: number;
  start: number;
  end: number;
  text: string;
  name?: string;
  distance?: number;
};
```

The `Match` shape is aligned with the other Stella
text-search packages.

## Development

```bash
bun install
bun test
bun run lint
bun run format
bun run build
cargo fmt --all --check
cargo clippy --all-targets --locked
cargo test --locked
```

Run `bun run typecheck` to check types with `bun check --no-pretty --all --project=tsconfig.json`.
Run `bun run check:typecheck-parity` to compare repository diagnostics and seeded diagnostic classes with TypeScript; CI runs the ordinary typecheck for code changes, while the dispatch-only Typecheck proofs workflow runs parity.
Editors continue to use the TypeScript language service because Bun has no language server.
The `typescript` dependency also supports declaration generation through tsdown.

## Built on

- [@stll/aho-corasick](https://github.com/stella/aho-corasick)
- [@stll/regex-set](https://github.com/stella/regex-set)
- [@stll/fuzzy-search](https://github.com/stella/fuzzy-search)

## License

[Apache-2.0](./LICENSE)
