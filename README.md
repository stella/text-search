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

const matches = search.findIter(
  "Ing. Jan Novak, s.r.o., born 15.03.1990.",
);
```

## Routing model

Patterns are classified once at construction time.

| Engine | Used for |
| --- | --- |
| Aho-Corasick | Pure literals and explicit `literal: true` entries |
| RegexSet | Standard regex patterns |
| FuzzySearch | Entries with a `distance` field |

Large alternation-heavy regexes are isolated into
their own RegexSet instance so they do not poison
the shared DFA for simpler patterns.

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

## API

| Method | Returns | Description |
| --- | --- | --- |
| `findIter(text)` | `Match[]` | Find matches in input text |
| `isMatch(text)` | `boolean` | Fast yes/no check |
| `whichMatch(text)` | `number[]` | Pattern indices that matched |
| `replaceAll(text, replacements)` | `string` | Replace matched ranges |
| `length` | `number` | Number of configured patterns |

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
```

## Built on

- [@stll/aho-corasick](https://github.com/stella/aho-corasick)
- [@stll/regex-set](https://github.com/stella/regex-set)
- [@stll/fuzzy-search](https://github.com/stella/fuzzy-search)

## License

[MIT](./LICENSE)
