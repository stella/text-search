import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { library } from "@stll/oxlint-config";
import {
  portableSafetyPluginSpecifiers,
  portableSafetyRules,
} from "@stll/oxlint-plugin";

import config from "../oxlint.config";
import { at, readJson, readToml, texts } from "./structured-data";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("uses shared library defaults and the complete portable safety pack", () => {
  expect(config).toEqual(
    library({
      jsPlugins: portableSafetyPluginSpecifiers,
      rules: portableSafetyRules,
    }),
  );
  for (const override of config.overrides ?? []) {
    for (const [rule, severity] of Object.entries(portableSafetyRules)) {
      expect(override.rules?.[rule]).toBe(severity);
    }
  }
  const tsconfig = readJson("tsconfig.json");
  expect(at(tsconfig, "extends")).toBe("@stll/typescript-config/library.json");
  expect(at(tsconfig, "compilerOptions")).toBeUndefined();
});

test("declares runtime-only generated cloud setup with Rust checks", () => {
  const cloud = at(readJson("stll-toolchain.json"), "cloud");
  expect(at(cloud, "install")).toBe("bun install --frozen-lockfile");
  expect(at(cloud, "rust", "components")).toEqual(["clippy", "rustfmt"]);
  expect(at(cloud, "rust", "targets")).toEqual(["wasm32-unknown-unknown"]);
  const script = read(".agents/cloud-setup.sh");
  expect(script).toContain("Generated");
  expect(script).toContain(read(".node-version").trim());
  expect(script).toContain("install --frozen-lockfile");
  expect(script).not.toContain(".env.cloud");
  expect(
    at(readJson(".claude/settings.json"), "hooks", "SessionStart"),
  ).toHaveLength(1);
});

test("keeps third-party quarantine and exact first-party tooling exemptions", () => {
  const bunfig = readToml("bunfig.toml");
  expect(at(bunfig, "install", "minimumReleaseAge")).toBe(432_000);
  const exceptions = texts(bunfig, "install", "minimumReleaseAgeExcludes");
  for (const name of [
    "@stll/oxlint-config",
    "@stll/oxlint-plugin",
    "@stll/typescript-config",
  ]) {
    expect(exceptions).toContain(name);
  }
  expect(exceptions.every((name) => !name.includes("*"))).toBe(true);
  // A third-party exclusion is temporary: it names when quarantine admits it.
  const lines = read("bunfig.toml").split("\n");
  for (const name of exceptions.filter((entry) => !entry.startsWith("@stll/")))
    expect(
      lines.some(
        (line) =>
          line.includes(`"${name}"`) && line.includes("# quarantine-expires:"),
      ),
    ).toBe(true);
});
