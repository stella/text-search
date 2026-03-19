# @stll/text-search

Multi-engine text search orchestrator. Routes
patterns to the optimal engine with automatic
optimization for large alternations.

## Install

```bash
npm install @stll/text-search
# or
bun add @stll/text-search
```

## Usage

```typescript
import { TextSearch } from "@stll/text-search";

const ts = new TextSearch([
  // Simple patterns → shared multi-pattern DFA
  /\b\d{2}\.\d{2}\.\d{4}\b/,
  /\b[\w.+-]+@[\w-]+\.[\w]+\b/,
  /\b\d{6}\/\d{3,4}\b/,

  // Large alternation → auto-isolated engine
  `(?:${titles.join("|")})\\s+[A-Z][a-z]+`,

  // Named patterns
  { pattern: /\+?\d{9,12}/, name: "phone" },
]);

ts.findIter("Ing. Jan Novák, born 15.03.1990");
// [
//   { pattern: 3, text: "Ing. Jan Novák", ... },
//   { pattern: 0, text: "15.03.1990", ... },
// ]
```

## Auto-optimization

Patterns with more than 50 top-level alternation
branches (configurable via `maxAlternations`) are
automatically isolated into their own RegexSet
instance. This prevents DFA state explosion when
large alternations are combined with other patterns.

```typescript
// Without text-search: 8ms (DFA state explosion)
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
  wholeWords: true,

  // Max alternation branches before auto-split
  // (default: 50)
  maxAlternations: 50,
});
```

## API

| Method | Returns | Description |
| --- | --- | --- |
| `.findIter(text)` | `Match[]` | All non-overlapping matches |
| `.isMatch(text)` | `boolean` | Any pattern matches? |
| `.whichMatch(text)` | `number[]` | Which pattern indices matched |
| `.replaceAll(text, replacements)` | `string` | Replace matches |
| `.length` | `number` | Number of patterns |

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

Same `Match` type as `@stll/regex-set` and
`@stll/aho-corasick`.

## How it works

1. **Classify**: count alternation branches per pattern
2. **Route**: large alternations → isolated RegexSet,
   normal patterns → shared RegexSet
3. **Search**: each engine scans the text independently
4. **Merge**: combine results, sort by position,
   select non-overlapping (longest first at ties)

## License

[MIT](./LICENSE)
