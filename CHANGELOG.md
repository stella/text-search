# Changelog

## 0.1.0 (2026-03-22)

### Features

- Multi-engine text search orchestrator
- Automatic pattern classification (literal, regex, fuzzy)
- Aho-Corasick routing for pure literal patterns
- RegexSet routing for regex patterns
- FuzzySearch routing for approximate matching
- DFA isolation for large alternation patterns
- Named pattern support
- Case-insensitive and whole-word matching
- Unicode boundary support

### Built on

- [@stll/aho-corasick](https://github.com/stella/aho-corasick) — NAPI-RS Aho-Corasick
- [@stll/regex-set](https://github.com/stella/regex-set) — NAPI-RS multi-pattern regex
- [@stll/fuzzy-search](https://github.com/stella/fuzzy-search) — NAPI-RS fuzzy matching
