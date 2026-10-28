import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import toolchainPolicy from "@stll/oxlint-config/toolchain.json" with { type: "json" };

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("preserves shared detector changes and domain checks", () => {
  const workflow = read(".github/workflows/ci.yml");
  expect(workflow).toContain('stll-toolchain-changed --since "$BASE_REF"');
  expect(workflow).toContain("fetch-depth: 0");
  expect(workflow).toContain("bun install --frozen-lockfile --ignore-scripts");
  expect(workflow).toContain(
    "github.event.pull_request.base.sha || github.event.before",
  );
  expect(workflow).toContain("'unavailable-toolchain-base'");
  expect(workflow).toContain(
    "steps.filter.outputs.code == 'true' || steps.toolchain.outputs.changed == 'true'",
  );
  expect(workflow).toContain(
    "steps.filter.outputs.provenance == 'true' || steps.toolchain.outputs.changed == 'true'",
  );
  const domain = workflow
    .split("            code:")
    .at(1)
    ?.split("            provenance:")
    .at(0);
  expect(domain).toContain("'crates/**'");
  expect(domain).toContain("'src/**'");
  for (const path of [
    "package.json",
    "bun.lock",
    "bunfig.toml",
    "tsconfig.json",
    "tsdown.config.ts",
  ]) {
    expect(domain).toContain(`'${path}'`);
  }
});

test("pins ordinary runtimes and bounds the Hawk compiler exception", () => {
  const workflow = read(".github/workflows/ci.yml");
  expect(workflow).toContain(`toolchain: "${toolchainPolicy.rust}"`);
  expect(workflow).toContain('HAWK_RUST_TOOLCHAIN: "1.97.1"');
  expect(read(".node-version").trim()).toBe("26.10.0");
  const declaration = JSON.parse(read("stll-toolchain.json"));
  expect(declaration.rustExceptions).toHaveLength(1);
  expect(declaration.rustExceptions.at(0)).toMatchObject({
    pin: "1.97.1",
    tracking: "https://github.com/stella/tooling/issues/99",
    expires: "2026-11-11",
  });
});
