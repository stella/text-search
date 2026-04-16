import type { Plugin, UserConfig } from "vite";

export const WASM_VITE_PACKAGES = [
  "@stll/text-search-wasm",
  "@stll/aho-corasick-wasm",
  "@stll/aho-corasick-wasm32-wasi",
  "@stll/fuzzy-search-wasm",
  "@stll/fuzzy-search-wasm32-wasi",
  "@stll/regex-set-wasm",
  "@stll/regex-set-wasm32-wasi",
] as const;

function mergeStrings(
  existing: string[] | undefined,
  additions: readonly string[],
): string[] {
  return [...new Set([...(existing ?? []), ...additions])];
}

export function buildTextSearchWasmViteConfig(
  config: UserConfig = {},
): UserConfig {
  return {
    ...config,
    optimizeDeps: {
      ...config.optimizeDeps,
      exclude: mergeStrings(
        config.optimizeDeps?.exclude,
        WASM_VITE_PACKAGES,
      ),
    },
    ssr: {
      ...config.ssr,
      external:
        config.ssr?.external === true
          ? true
          : mergeStrings(config.ssr?.external, WASM_VITE_PACKAGES),
    },
  };
}

export default function stllTextSearchWasmVite(): Plugin {
  return {
    name: "stll-text-search-wasm",
    config(config) {
      return buildTextSearchWasmViteConfig(config);
    },
  };
}
