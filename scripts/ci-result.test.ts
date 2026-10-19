import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const readWorkflow = (path: string) =>
  Bun.YAML.parse(readFileSync(new URL(path, root), "utf8"));

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
    },
  }).exitCode;

test("ci-result covers every CI validation job", () => {
  const workflow = readWorkflow(".github/workflows/ci.yml");
  const jobs = workflow.jobs;
  const aggregate = jobs["ci-result"];
  const validationJobs = Object.keys(jobs).filter((name) => name !== "ci-result");

  expect(aggregate.needs).toEqual(expect.arrayContaining(validationJobs));
  expect(aggregate.needs).toHaveLength(validationJobs.length);
  expect(aggregate.if).toBe("always()");

  const rejectStep = aggregate.steps.find(
    (step: { name?: string }) => step.name === "Reject untrusted pull requests",
  );
  expect(rejectStep).toMatchObject({
    if: "github.event_name == 'pull_request' && needs.trust-check.outputs.trusted != 'true'",
    run: "exit 1",
  });

  const verdictStep = aggregate.steps.find(
    (step: { name?: string }) => step.name === "Require every selected validation job",
  );
  expect(verdictStep.if).toBe(
    "github.event_name != 'pull_request' || needs.trust-check.outputs.trusted == 'true'",
  );
  expect(runVerdict(verdictStep.run, "failure")).not.toBe(0);
  expect(runVerdict(verdictStep.run, "cancelled")).not.toBe(0);
  expect(runVerdict(verdictStep.run, "success")).toBe(0);
});

test("CI and CLA workflows handle merge groups", () => {
  for (const path of [".github/workflows/ci.yml", ".github/workflows/cla.yml"]) {
    const workflow = readWorkflow(path);
    expect(workflow.on.merge_group.types).toEqual(["checks_requested"]);
  }
});
