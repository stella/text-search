import { defineConfig } from "tsdown";

import wasmManifest from "./wasm/package.json";

const wasmImports = Object.keys({
  ...wasmManifest.dependencies,
  ...wasmManifest.peerDependencies,
});

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
      neverBundle: Object.keys(wasmManifest.dependencies),
      // The shared entity contract derives from native types; browser consumers
      // receive those declarations inline without installing native binaries.
      dts: { alwaysBundle: ["@stll/fuzzy-search"] },
      onlyImport: wasmImports,
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
    deps: { neverBundle: [/^vite$/], onlyImport: wasmImports },
  },
]);
