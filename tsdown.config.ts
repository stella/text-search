import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    outDir: "dist",
    format: ["esm"],
    dts: { generator: "oxc" },
    clean: true,
    sourcemap: true,
    hash: false,
  },
  {
    entry: ["src/wasm.ts"],
    outDir: "wasm/dist",
    format: ["esm"],
    dts: { generator: "oxc" },
    clean: true,
    sourcemap: true,
    hash: false,
    deps: {
      neverBundle: [
        /^@stll\/aho-corasick-wasm$/,
        /^@stll\/fuzzy-search-wasm$/,
        /^@stll\/regex-set-wasm$/,
      ],
    },
  },
  {
    entry: ["src/vite.ts"],
    outDir: "wasm/dist",
    format: ["esm"],
    dts: { generator: "oxc" },
    clean: false,
    sourcemap: true,
    hash: false,
    deps: { neverBundle: [/^vite$/] },
  },
]);
