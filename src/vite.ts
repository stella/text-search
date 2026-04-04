/* Vite plugin that wires up @stll/text-search-wasm so its transitive
 * napi-rs-generated wasm loaders survive Vite's dep pre-bundler. Adds
 * this package plus its @stll/*-wasm dependencies to optimizeDeps.exclude
 * so the loader modules are served with their original paths, keeping
 * `new URL("./foo.wasm", import.meta.url)` correct. */
import type { Plugin } from "vite";

const PACKAGES = [
  "@stll/text-search-wasm",
  "@stll/aho-corasick-wasm",
  "@stll/fuzzy-search-wasm",
  "@stll/regex-set-wasm",
];

export default function stllTextSearchWasmVite(): Plugin {
  return {
    name: "stll-text-search-wasm",
    config() {
      return {
        optimizeDeps: { exclude: PACKAGES },
      };
    },
  };
}
