/**
 * Late-bound engine registry.
 *
 * Native and WASM entry points call initEngines()
 * with their respective implementations before any
 * TextSearch instance is created.
 */

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Constructor = new (...args: any[]) => any;

type Engines = {
  AhoCorasick: Constructor;
  FuzzySearch: Constructor;
  RegexSet: Constructor;
};

let engines: Engines | undefined;

export const initEngines = (e: Engines): void => {
  engines = e;
};

export const getEngines = (): Engines => {
  if (!engines) {
    throw new Error(
      "Engines not initialized. Import from " +
        "@stll/text-search or @stll/text-search-wasm, " +
        "not from internal modules.",
    );
  }
  return engines;
};
