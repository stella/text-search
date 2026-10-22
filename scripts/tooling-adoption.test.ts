import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { library } from "@stll/oxlint-config";
import {
  portableSafetyPluginSpecifiers,
  portableSafetyRules,
} from "@stll/oxlint-plugin";

import config from "../oxlint.config";

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
  const tsconfig = JSON.parse(read("tsconfig.json"));
  expect(tsconfig.extends).toBe("@stll/typescript-config/library.json");
  expect(tsconfig.compilerOptions).toBeUndefined();
});

test("declares runtime-only generated cloud setup with Rust checks", () => {
  const toolchain = JSON.parse(read("stll-toolchain.json"));
  expect(toolchain.cloud.install).toBe("bun install --frozen-lockfile");
  expect(toolchain.cloud.rust.components).toEqual(["clippy", "rustfmt"]);
  expect(toolchain.cloud.rust.targets).toEqual(["wasm32-unknown-unknown"]);
  const script = read(".agents/cloud-setup.sh");
  expect(script).toContain("Generated");
  expect(script).toContain(read(".node-version").trim());
  expect(script).toContain("install --frozen-lockfile");
  expect(script).not.toContain(".env.cloud");
  const settings = JSON.parse(read(".claude/settings.json"));
  expect(settings.hooks.SessionStart).toHaveLength(1);
});

test("keeps third-party quarantine and exact first-party tooling exemptions", () => {
  const bunfig = Bun.TOML.parse(read("bunfig.toml"));
  expect(bunfig.install.minimumReleaseAge).toBe(432_000);
  const exceptions = bunfig.install.minimumReleaseAgeExcludes;
  for (const name of [
    "@stll/oxlint-config",
    "@stll/oxlint-plugin",
    "@stll/typescript-config",
  ]) {
    expect(exceptions).toContain(name);
  }
  expect(
    exceptions.every(
      (name: string) => name.startsWith("@stll/") && !name.includes("*"),
    ),
  ).toBe(true);
});
