---
"@stll/text-search": patch
---

Require the engine releases that start in a browser: `@stll/aho-corasick` 2.0.3, `@stll/fuzzy-search` 1.4.2 and `@stll/regex-set` 1.1.0, with their WebAssembly packages. Earlier releases paired emnapi 2.0.0-beta.2 with a runtime that does not match it, so the threaded WebAssembly build could fail to load.
