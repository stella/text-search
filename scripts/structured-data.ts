import { readFileSync } from "node:fs";

/**
 * Typed reads of parsed JSON, YAML and TOML for repository policy tests.
 * Parsers return untyped data; these helpers check the shape at each step
 * so a changed file fails with the path that broke instead of `any` flowing
 * into assertions.
 */
type Key = string | number;

const root = new URL("../", import.meta.url);

export const readText = (path: string): string =>
  readFileSync(new URL(path, root), "utf8");

export const readJson = (path: string): unknown => {
  const parsed: unknown = JSON.parse(readText(path));
  return parsed;
};

export const readYaml = (path: string): unknown =>
  Bun.YAML.parse(readText(path));

export const readToml = (path: string): unknown =>
  Bun.TOML.parse(readText(path));

const label = (path: readonly Key[]) =>
  path.length === 0 ? "<root>" : path.map(String).join(".");

/** The value at `path`, or `undefined` when the last key is absent. */
export const at = (value: unknown, ...path: Key[]): unknown => {
  let current = value;
  for (const [index, key] of path.entries()) {
    if (typeof current !== "object" || current === null)
      throw new TypeError(
        `${label(path.slice(0, index))} is not an object or array`,
      );
    const next: unknown = Reflect.get(current, key);
    current = next;
  }
  return current;
};

export const text = (value: unknown, ...path: Key[]): string => {
  const found = at(value, ...path);
  if (typeof found !== "string")
    throw new TypeError(`${label(path)} is not a string`);
  return found;
};

export const list = (value: unknown, ...path: Key[]): unknown[] => {
  const found = at(value, ...path);
  if (!Array.isArray(found))
    throw new TypeError(`${label(path)} is not an array`);
  return Array.from(found as unknown[]);
};

export const entries = (
  value: unknown,
  ...path: Key[]
): [string, unknown][] => {
  const found = at(value, ...path);
  if (typeof found !== "object" || found === null || Array.isArray(found))
    throw new TypeError(`${label(path)} is not an object`);
  return Object.entries(found);
};

export const texts = (value: unknown, ...path: Key[]): string[] =>
  list(value, ...path).map((item, index) => {
    if (typeof item !== "string")
      throw new TypeError(`${label([...path, index])} is not a string`);
    return item;
  });
