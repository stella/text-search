// Configured the way the README tells Vite users to: the package plugin, plus
// the cross-origin isolation headers the threaded WASM build needs.
import { defineConfig } from "vite";

import stllTextSearchWasm from "@stll/text-search-wasm/vite";

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [stllTextSearchWasm()],
  server: { headers: isolation },
  preview: { headers: isolation, port: 4789, strictPort: true },
});
