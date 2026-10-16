import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

test("repository workflows satisfy the installed shared toolchain guard", () => {
  const result = spawnSync("bunx", ["--no-install", "stll-toolchain-check"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const workflow = read(".github/workflows/ci.yml");
  expect(workflow).toContain('HAWK_RUST_TOOLCHAIN: "1.97.1"');
  expect(workflow).toContain('toolchain: "1.97.1"');
  const manifest = JSON.parse(read("package.json"));
  expect(manifest.scripts["rust:hawk"]).toContain("cargo +1.97.1 hawk");
});

test("first-party quarantine exemptions use exact supported annotations", () => {
  const text = read("bunfig.toml");
  const configuration = Bun.TOML.parse(text);
  for (const name of configuration.install.minimumReleaseAgeExcludes) {
    expect(name).toStartWith("@stll/");
    expect(name).not.toContain("*");
    const line = text
      .split("\n")
      .find((entry) => entry.trimStart().startsWith(JSON.stringify(name) + ","));
    expect(line).toMatch(
      /^\s*"[^"]+",?\s*#\s*quarantine-excluded-since:\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s*$/u,
    );
  }
});
