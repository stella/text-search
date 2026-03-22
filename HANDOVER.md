# Hyperscan-Inspired Literal Pre-filtering

## Problem

Currently, `TextSearch` routes patterns to engines at
**compile time** based on static classification:

- Pure literals → Aho-Corasick (fast)
- Regex patterns → RegexSet (slower)
- Fuzzy patterns → FuzzySearch

Each engine then scans the **full text** independently.
For regex-heavy workloads, this means RegexSet processes
every byte of the document, even when most of the text
couldn't possibly match.

## Insight (from Hyperscan/Vectorscan)

Most regex patterns contain **required literal substrings**.
For example:

```
Pattern: rodné číslo:\s*\d{6}/\d{4}
Required literal: "rodné číslo:"

Pattern: (foo|bar)\s+\d+
Required literals: "foo" OR "bar"

Pattern: \d{6}/\d{4}
Required literal: NONE (no useful literal)
```

If the required literal isn't present in the text, the
regex **cannot match**. This is the Hyperscan pre-filter
principle.

## Architecture

### Two-Phase Pipeline

```
Phase 1: AC PRE-FILTER (fast, full text)
  Extract required literals from regex patterns.
  Build AC automaton with all extracted literals.
  Scan full text once → get candidate positions.
  Patterns whose literals are absent → skip entirely.

Phase 2: REGEX VALIDATION (slow, tiny regions)
  For each AC hit:
    - Identify which regex pattern(s) need this literal
    - Extract a small region around the hit (± margin)
    - Run only those regex patterns on that region
  Patterns with no extractable literals → fallback to
  full-text scan (unavoidable, but rare).
```

### Literal Extraction

Parse regex strings to find required literal substrings:

| Regex construct     | Extracted literal          |
| ------------------- | -------------------------- |
| `"rodné číslo:"`    | `"rodné číslo:"`           |
| `"(?:foo\|bar)\d+"` | `["foo", "bar"]` (any-of)  |
| `"\d{6}/\d{4}"`     | `"/"` (if long enough)     |
| `"\d+"`             | NONE (no literal)          |
| `"IČO:\s*\d{8}"`    | `"IČO:"`                   |

Rules:
- Walk the regex string character by character
- Accumulate runs of literal characters
- On metachar or alternation, flush the current run
- Keep the longest literal run(s)
- Minimum useful literal length: 2 chars (single chars
  are too common to be useful as filters)

### Margin Calculation

When AC finds a literal at position `p`, the regex might
match starting before `p` (prefix) or extending after
(suffix). The margin is:

```
margin_before = (regex_length_estimate - literal_offset)
margin_after  = (regex_length_estimate - literal_length + literal_offset)
```

Conservative default: 64 bytes on each side. This covers
most legal patterns (dates, IDs, phone numbers) with room
to spare.

### Fallback

Patterns with no extractable literal (e.g., `\d+`, `\s+`)
fall back to full-text RegexSet scan. This is the same as
the current behavior, just limited to the subset of
patterns that truly need it.

## Expected Performance Impact

- **Best case** (most patterns have literals): 5-10x faster.
  AC scans at ~1GB/s; regex only runs on tiny windows.
- **Worst case** (no patterns have literals): identical to
  current. Falls back to full-text RegexSet.
- **Typical legal workload**: 3-5x faster. Most legal
  patterns contain identifiable keywords (IČO, DIČ, rodné
  číslo, datum narození, etc.).

## Implementation Location

All changes are in the **JS orchestrator** (`text-search`).
No changes to the Rust engines (`aho-corasick`, `regex-set`,
`fuzzy-search`). The engines are used as-is; the
optimization is purely in how they're composed.

## Key Files

- `src/extract-literals.ts` — literal extraction from regex
- `src/prefilter.ts` — AC pre-filter + region extraction
- `src/text-search.ts` — updated to use pre-filter pipeline
- `src/classify.ts` — unchanged (still classifies patterns)
- `__bench__/prefilter.ts` — benchmark comparing approaches
