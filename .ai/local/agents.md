## Repository Specifics

`@stll/text-search` orchestrates multiple text-search engines and routes patterns to the best available implementation.

### Commands

- `bun install`
- `bun run lint`
- `bun run typecheck` (`bun check --no-pretty --all --project=tsconfig.json`)
- `bun run check:typecheck-parity`
- `bun test`
- `bun run test:runtime:bun`
- `bun run test:runtime:node`
- `bun run build`
- `bun run version:check`

### Working Rules

- Keep routing decisions explicit: literal, regex, fuzzy, and fallback engines should be testable without relying on incidental implementation details.
- Preserve match ordering, offsets, and replace-safe spans across engines.
- Keep dependency versions aligned with the underlying `@stll/aho-corasick`, `@stll/regex-set`, and `@stll/fuzzy-search` packages.

### TypeScript Tooling

Use `bun run typecheck` for type checking and `bun run check:typecheck-parity` to verify diagnostic coverage against TypeScript. Editors keep the TypeScript language service because Bun has no language server. Keep `typescript` for editor support and declaration generation through tsdown.
