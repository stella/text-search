import { YAML } from "bun";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const readWorkflow = (name) =>
  YAML.parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));
const workflow = readWorkflow("ci.yml");
const compact = (value) => (typeof value === "string" ? value.replace(/\$\{\{|\}\}|\s/g, "") : "");
const trustedInput =
  "(github.event_name!='pull_request'||needs.trust-check.outputs.trusted=='true')&&'true'||'false'";
const directGate =
  /^always\(\)&&!cancelled\(\)(?:&&needs\.check-changes\.(?:result=='success'|outputs\.(?:rust|build|code|provenance)-changed=='true'))*&&\(github\.event_name!='pull_request'\|\|needs\.trust-check\.outputs\.trusted=='true'\)(?:&&needs\.check-changes\.(?:result=='success'|outputs\.(?:rust|build|code|provenance)-changed=='true'))*$/;
const changesetGate =
  "github.event_name=='pull_request'&&needs.trust-check.outputs.trusted=='true'";

const violations = ({ jobs }) => {
  const failures = [];
  for (const [name, job] of Object.entries(jobs)) {
    if (name === "trust-check") {
      if (
        job.steps.some(
          (step) =>
            step.uses || /scripts\/|\b(?:node|bun|cargo|npm|python|uv)\b/.test(step.run ?? ""),
        )
      )
        failures.push(name);
      continue;
    }
    if (name === "check-changes") {
      if (
        job.steps.some(
          (step) =>
            step.run ||
            !/^(?:actions\/checkout|dorny\/paths-filter)@[a-f0-9]{40}$/.test(step.uses ?? ""),
        )
      )
        failures.push(name);
      continue;
    }
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
    const delegated =
      typeof job.uses === "string" &&
      !job.steps &&
      !job["runs-on"] &&
      compact(job.with?.trusted) === trustedInput;
    const condition = compact(job.if);
    if (
      !needs.includes("trust-check") ||
      (!directGate.test(condition) && condition !== changesetGate && !delegated)
    )
      failures.push(name);
  }
  return failures;
};

test("every executable CI job requires the fork trust gate", () => {
  expect(Object.keys(workflow.jobs).length).toBeGreaterThan(2);
  expect(violations(workflow)).toEqual([]);
  expect(violations(readWorkflow("ai-sync.yml"))).toEqual([]);
});

test("removing any executable job dependency trips the guard", () => {
  for (const name of Object.keys(workflow.jobs)) {
    if (name === "trust-check" || name === "check-changes") continue;
    const changed = structuredClone(workflow);
    delete changed.jobs[name].needs;
    expect(violations(changed)).toContain(name);
  }
});

test("metadata steps and commented job keys cannot conceal execution", () => {
  const changed = structuredClone(workflow);
  changed.jobs["check-changes"].steps.push({ run: "node scripts/version-sync.mjs check" });
  delete changed.jobs["workflow-lint"].needs;
  changed.jobs["workflow-lint"].steps.push({
    run: "./scripts/check.sh\n  # fake-job:\n    # needs: [trust-check]",
  });
  expect(violations(YAML.parse(YAML.stringify(changed)))).toEqual([
    "check-changes",
    "workflow-lint",
  ]);
});

test("only a reusable caller may delegate trust through with.trusted", () => {
  const changed = structuredClone(workflow);
  changed.jobs["new-release-check"] = {
    "runs-on": "ubuntu-latest",
    needs: ["trust-check"],
    env: { trusted: `\${{ ${trustedInput} }}` },
    steps: [{ run: "node scripts/version-sync.mjs check" }],
  };
  expect(violations(changed)).toEqual(["new-release-check"]);
});
