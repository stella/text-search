import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const readWorkflow = (path: string) =>
  Bun.YAML.parse(readFileSync(new URL(path, root), "utf8"));

test("ci-result covers every CI validation job", () => {
  const workflow = readWorkflow(".github/workflows/ci.yml");
  const jobs = workflow.jobs;
  const aggregate = jobs["ci-result"];
  const validationJobs = Object.keys(jobs).filter((name) => name !== "ci-result");

  expect(aggregate.needs).toEqual(expect.arrayContaining(validationJobs));
  expect(aggregate.needs).toHaveLength(validationJobs.length);
  expect(aggregate.if.trim().replace(/\s+/gu, " ")).toBe(
    "always() && ((github.event_name == 'pull_request' && needs.trust-check.outputs.trusted == 'true') || github.event_name == 'merge_group')",
  );
});

test("CI and CLA workflows handle merge groups", () => {
  for (const path of [".github/workflows/ci.yml", ".github/workflows/cla.yml"]) {
    const workflow = readWorkflow(path);
    expect(workflow.on.merge_group.types).toEqual(["checks_requested"]);
  }
});
