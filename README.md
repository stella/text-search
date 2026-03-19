<p align="center">
  <img src=".github/assets/banner.png" alt="Stella" width="100%" />
</p>

# @stll/text-search

Multi-engine text search orchestrator for
Node.js and Bun. Routes patterns to the optimal
engine automatically: Aho-Corasick for literals,
RegexSet for regex, FuzzySearch for approximate
matching, with auto-optimization for large
alternations.

Part of the
[@stll text search ecosystem](https://github.com/stella):
[@stll/regex-set](https://github.com/stella/regex-set),
[@stll/aho-corasick](https://github.com/stella/aho-corasick),
[@stll/fuzzy-search](https://github.com/stella/fuzzy-search).

## Install

```bash
npm install @stll/text-search
# or
bun add @stll/text-search
```

Requires `@stll/regex-set`, `@stll/aho-corasick`,
and `@stll/fuzzy-search` as peer dependencies
(installed automatically).

## Usage

```typescript
import { TextSearch } from "@stll/text-search";

const ts = new TextSearch([
  // Regex patterns → RegexSet (DFA)
  /\b\d{2}\.\d{2}\.\d{4}\b/,
  /\b[\w.+-]+@[\w-]+\.[\w]+\b/,

  // Pure literals → Aho-Corasick (SIMD)
  "Confidential",
  "Attorney-Client Privilege",

  // Fuzzy patterns → FuzzySearch (Levenshtein)
  { pattern: "Novák", distance: 1, name: "person" },

  // Large alternation → auto-isolated RegexSet
  `(?:${titles.join("|")})\\s+[A-Z][a-z]+`,

  // Named patterns
  { pattern: /\+?\d{9,12}/, name: "phone" },
]);

ts.findIter("Ing. Jan Novak, born 15.03.1990");
// [
//   { pattern: 5, text: "Ing. Jan Novak", ... },
//   { pattern: 4, text: "Novak", distance: 1, ... },
//   { pattern: 0, text: "15.03.1990", ... },
// ]
```

## Engine routing

Patterns are classified and routed to the optimal
engine at construction time:

| Engine | Condition | Performance |
| --- | --- | --- |
| Aho-Corasick | Pure literal strings | SIMD-accelerated |
| RegexSet (shared) | Normal regex patterns | Single-pass DFA |
| RegexSet (isolated) | >50 alternation branches | Prevents DFA explosion |
| FuzzySearch | `distance` field present | Levenshtein/Damerau |

Large alternation patterns (e.g., 80+ title
prefixes) are automatically isolated into their
own RegexSet instance, preventing DFA state
explosion when combined with other patterns.

```typescript
// Without text-search: 73ms (DFA state explosion)
new RegexSet([hugePattern, simplePattern]);

// With text-search: 0.4ms (auto-split)
new TextSearch([hugePattern, simplePattern]);
```

## Options

```typescript
new TextSearch(patterns, {
  // Unicode word boundaries (default: true)
  unicodeBoundaries: true,

  // Only match whole words (default: false)
  wholeWords: false,

  // Max alternation branches before auto-split
  // (default: 50)
  maxAlternations: 50,

  // Fuzzy matching options
  fuzzyMetric: "levenshtein",    // or "damerau-levenshtein"
  normalizeDiacritics: false,
  caseInsensitive: false,
});
```

## API

| Method | Returns | Description |
| --- | --- | --- |
| `findIter(text)` | `Match[]` | All non-overlapping matches |
| `isMatch(text)` | `boolean` | Any pattern matches? |
| `whichMatch(text)` | `number[]` | Which pattern indices matched |
| `replaceAll(text, replacements)` | `string` | Replace matches |
| `length` | `number` | Number of patterns |

## Pattern entry types

```typescript
// Simple string (literal → AC, regex → RegexSet)
"foo"

// RegExp object → RegexSet
/\btest\b/i

// Named pattern
{ pattern: "\\d+", name: "number" }

// Fuzzy pattern → FuzzySearch
{ pattern: "Novák", distance: 1 }
{ pattern: "Smith", distance: "auto", name: "person" }
```

## Match type

```typescript
type Match = {
  pattern: number;  // original pattern index
  start: number;    // UTF-16 offset
  end: number;      // exclusive
  text: string;     // matched substring
  name?: string;    // pattern name (if provided)
};
```

Same `Match` shape as `@stll/regex-set`,
`@stll/aho-corasick`, and `@stll/fuzzy-search`.

## How it works

1. **Classify**: detect literals, count alternation
   branches, identify fuzzy patterns
2. **Route**: literals → AC, fuzzy → FuzzySearch,
   large alternations → isolated RegexSet,
   normal regex → shared RegexSet
3. **Search**: each engine scans the text
4. **Merge**: combine results, sort by position,
   select non-overlapping (longest match at ties)

## Development

```bash
bun install
bun test
bun run lint
bun run format
bun run build
```

## Built on
- [@stll/regex-set](https://github.com/stella/regex-set) —
  NAPI-RS bindings to Rust regex-automata
- [@stll/aho-corasick](https://github.com/stella/aho-corasick) —
  NAPI-RS bindings to Rust aho-corasick
- [@stll/fuzzy-search](https://github.com/stella/fuzzy-search) —
  NAPI-RS Levenshtein/Damerau-Levenshtein matcher

## License

[MIT](./LICENSE)
