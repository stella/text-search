import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import {
  at,
  entries,
  readJson,
  readToml,
  readYaml,
  text,
  texts,
} from "./structured-data";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

// The guard takes about 1.5 s in CI; on pull requests it can also fetch the
// base commit of a shallow checkout over the network, so allow 30 s.
test("repository workflows satisfy the installed shared toolchain guard", () => {
  const result = spawnSync("bunx", ["--no-install", "stll-toolchain-check"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const workflow = read(".github/workflows/ci.yml");
  expect(workflow).toContain('HAWK_RUST_TOOLCHAIN: "1.97.1"');
  expect(workflow).toContain('toolchain: "1.97.1"');
  expect(text(readJson("package.json"), "scripts", "rust:hawk")).toContain(
    "cargo +1.97.1 hawk",
  );
}, 30_000);

test("change detection follows trust and the CI dependency graph stays acyclic", () => {
  const jobs = at(readYaml(".github/workflows/ci.yml"), "jobs");
  expect(at(jobs, "check-changes", "needs")).toEqual(["trust-check"]);
  expect(at(jobs, "trust-check", "needs")).toBeUndefined();
  const condition = text(jobs, "check-changes", "if")
    .trim()
    .replace(/\s+/gu, " ");
  expect(condition).toBe(
    "always() && !cancelled() && (github.event_name != 'pull_request' || needs.trust-check.outputs.trusted == 'true')",
  );
  for (const scenario of [
    { event: "pull_request", trust: "true", cancelled: false, expected: true },
    {
      event: "pull_request",
      trust: "false",
      cancelled: false,
      expected: false,
    },
    { event: "pull_request", trust: "", cancelled: false, expected: false },
    { event: "push", trust: "", cancelled: false, expected: true },
    { event: "workflow_dispatch", trust: "", cancelled: false, expected: true },
    { event: "pull_request", trust: "true", cancelled: true, expected: false },
  ]) {
    const result = runInNewContext(
      condition.replaceAll("needs.trust-check.", 'needs["trust-check"].'),
      {
        always: () => true,
        cancelled: () => scenario.cancelled,
        github: { event_name: scenario.event },
        needs: { "trust-check": { outputs: { trusted: scenario.trust } } },
      },
    );
    expect(result).toBe(scenario.expected);
  }
  const dependencies = (job: unknown) => {
    if (typeof job !== "object" || job === null || !("needs" in job)) return [];
    const needs = job.needs;
    if (typeof needs === "string") return [needs];
    if (
      Array.isArray(needs) &&
      needs.every((value: unknown) => typeof value === "string")
    )
      return needs;
    throw new Error("invalid CI dependency declaration");
  };
  const graph = new Map(
    entries(jobs).map(([name, job]) => [name, dependencies(job)] as const),
  );
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string): void => {
    expect(visiting.has(name)).toBe(false);
    if (visited.has(name)) return;
    const needs = graph.get(name);
    if (needs === undefined) throw new Error("unknown CI job: " + name);
    visiting.add(name);
    for (const dependency of needs) visit(dependency);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of graph.keys()) visit(name);
});

test("first-party quarantine exemptions use exact supported annotations", () => {
  const bunfig = read("bunfig.toml");
  for (const name of texts(
    readToml("bunfig.toml"),
    "install",
    "minimumReleaseAgeExcludes",
  )) {
    expect(name).not.toContain("*");
    const line = bunfig
      .split("\n")
      .find((entry) =>
        entry.trimStart().startsWith(JSON.stringify(name) + ","),
      );
    // First-party exemptions are permanent; a third-party exclusion names
    // the instant the normal quarantine admits it.
    const marker = name.startsWith("@stll/")
      ? "quarantine-excluded-since"
      : "quarantine-expires";
    expect(line).toMatch(
      new RegExp(
        `^\\s*"[^"]+",?\\s*#\\s*${marker}:\\s*\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z\\s*$`,
        "u",
      ),
    );
  }
});

test("delegates package quarantine enforcement with least privilege", () => {
  const policy = readYaml(".github/workflows/quarantine-policy.yml");
  expect(policy).toEqual({
    name: "Package quarantine policy",
    on: {
      pull_request: null,
      merge_group: null,
      push: { branches: ["main"] },
    },
    permissions: { contents: "read" },
    jobs: {
      enforce: {
        name: "Enforce package quarantine",
        if: "github.repository == 'stella/text-search'",
        permissions: { contents: "read" },
        uses: expect.stringMatching(
          /^stella\/\.github\/\.github\/workflows\/quarantine-policy\.yml@[0-9a-f]{40}$/u,
        ),
      },
    },
  });

  const prune = readYaml(".github/workflows/quarantine-prune.yml");
  expect(prune).toEqual({
    name: "Package quarantine prune",
    on: { schedule: [{ cron: "11 4 * * *" }] },
    permissions: { contents: "read" },
    jobs: {
      prune: {
        name: "Remove expired quarantine exceptions",
        if: "github.repository == 'stella/text-search'",
        permissions: { contents: "read" },
        uses: expect.stringMatching(
          /^stella\/\.github\/\.github\/workflows\/quarantine-prune\.yml@[0-9a-f]{40}$/u,
        ),
        secrets: {
          CHANGELOG_APP_ID: "${{ secrets.CHANGELOG_APP_ID }}",
          CHANGELOG_APP_PRIVATE_KEY: "${{ secrets.CHANGELOG_APP_PRIVATE_KEY }}",
        },
      },
    },
  });
  expect(text(policy, "jobs", "enforce", "uses").split("@").at(1)).toBe(
    text(prune, "jobs", "prune", "uses").split("@").at(1),
  );
});

test("quarantines Bun scripts and crates.io dependencies", () => {
  expect(at(readJson("package.json"), "trustedDependencies")).toEqual([]);
  expect(read(".cargo/config.toml")).toBe(
    '[registry]\nglobal-min-publish-age = "5 days"\n',
  );
  const quarantine = read(".cargo/quarantine.toml");
  for (const [name, timestamp] of [
    ["stella-aho-corasick-core", "2026-08-12T12:43:23.000Z"],
    ["stella-fuzzy-search-core", "2026-09-30T17:28:44.000Z"],
    ["stella-regex-set-core", "2026-08-12T12:43:30.000Z"],
  ]) {
    expect(quarantine).toContain(
      `"${name}", # quarantine-excluded-since: ${timestamp}`,
    );
  }
  const manifest = read("crates/core/Cargo.toml");
  for (const [name, version] of [
    ["stella-aho-corasick-core", "2.0.3"],
    ["stella-fuzzy-search-core", "1.4.2"],
    ["stella-regex-set-core", "1.1.0"],
  ]) {
    expect(manifest).toContain(`${name} = "=${version}"`);
  }
  expect(manifest).not.toContain('git = "https://github.com/stella/');
});
