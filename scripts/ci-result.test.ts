import { expect, test } from "bun:test";

import { at, entries, list, readYaml, text } from "./structured-data";

const runVerdict = (script: string, trustResult: string) =>
  Bun.spawnSync(["bash", "-c", script], {
    env: {
      EVENT_NAME: "pull_request",
      CHECK_CHANGES_RESULT: "success",
      TRUST_RESULT: trustResult,
      CHANGESET_RESULT: "success",
      WORKFLOW_LINT_RESULT: "success",
      VERSION_SYNC_RESULT: "success",
      LINT_RESULT: "success",
      TEST_RESULT: "success",
      RUST_RESULT: "success",
      HAWK_RESULT: "success",
      RUNTIME_RESULT: "success",
      PACK_RESULT: "success",
      PROVENANCE_RESULT: "success",
      BROWSER_RESULT: "success",
    },
  }).exitCode;

test("ci-result covers every CI validation job", () => {
  const jobs = at(readYaml(".github/workflows/ci.yml"), "jobs");
  const aggregate = at(jobs, "ci-result");
  const validationJobs = entries(jobs)
    .map(([name]) => name)
    .filter((name) => name !== "ci-result");

  expect(at(aggregate, "needs")).toEqual(
    expect.arrayContaining(validationJobs),
  );
  expect(list(aggregate, "needs")).toHaveLength(validationJobs.length);
  expect(at(aggregate, "if")).toBe("always()");

  const steps = list(aggregate, "steps");
  const rejectStep = steps.find(
    (step) => at(step, "name") === "Reject untrusted pull requests",
  );
  expect(rejectStep).toMatchObject({
    if: "github.event_name == 'pull_request' && needs.trust-check.outputs.trusted != 'true'",
    run: "exit 1",
  });

  const verdictStep = steps.find(
    (step) => at(step, "name") === "Require every selected validation job",
  );
  expect(at(verdictStep, "if")).toBe(
    "github.event_name != 'pull_request' || needs.trust-check.outputs.trusted == 'true'",
  );
  const verdict = text(verdictStep, "run");
  expect(runVerdict(verdict, "failure")).not.toBe(0);
  expect(runVerdict(verdict, "cancelled")).not.toBe(0);
  expect(runVerdict(verdict, "success")).toBe(0);
});

test("CI and CLA workflows handle merge groups", () => {
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/cla.yml",
  ]) {
    expect(at(readYaml(path), "on", "merge_group", "types")).toEqual([
      "checks_requested",
    ]);
  }
});
