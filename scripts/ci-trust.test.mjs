import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const jobs = (source) => [
  ...source
    .slice(source.indexOf("jobs:\n") + 6)
    .matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/gm),
];
const compact = (value) => value.replace(/^>-?\s*/, "").replace(/\$\{\{|\}\}|\s/g, "");
const trustedInput =
  "(github.event_name!='pull_request'||needs.trust-check.outputs.trusted=='true')&&'true'||'false'";
const directGate =
  /^always\(\)&&!cancelled\(\)(?:&&needs\.check-changes\.(?:result=='success'|outputs\.(?:rust|build|code|provenance)-changed=='true'))*&&\(github\.event_name!='pull_request'\|\|needs\.trust-check\.outputs\.trusted=='true'\)(?:&&needs\.check-changes\.(?:result=='success'|outputs\.(?:rust|build|code|provenance)-changed=='true'))*$/;

const violations = (source) => {
  const failures = [];
  for (const [, name, body] of jobs(source)) {
    if (name === "trust-check") {
      // The gate reads event metadata, without checking out or running repo code.
      if (/uses:|\b(?:node|bun|cargo|npm|python|uv)\b/.test(body)) failures.push(name);
      continue;
    }
    if (name === "workflow-lint") {
      if (/scripts\/|\b(?:node|bun|cargo|npm|python|uv)\b/.test(body)) failures.push(name);
      continue;
    }
    if (name === "check-changes") {
      // This metadata job may only check out files and classify changed paths.
      if (
        /\brun:/.test(body) ||
        [...body.matchAll(/uses:\s*([^\s]+)/g)].some(
          ([, action]) => !/^(?:actions\/checkout|dorny\/paths-filter)@[a-f0-9]{40}$/.test(action),
        )
      )
        failures.push(name);
      continue;
    }
    const needs = body.match(/^    needs:\s*\[([^\]]*)\]/m);
    if (
      !needs ||
      !needs[1]
        .split(",")
        .map((name) => name.trim())
        .includes("trust-check")
    ) {
      failures.push(name);
      continue;
    }
    const condition = compact(body.match(/^    if:\s*([\s\S]*?)(?=^    \w[\w-]*:)/m)?.[1] ?? "");
    const delegated = compact(body.match(/^      trusted:\s*([^\n]+)/m)?.[1] ?? "");
    const changesetGate =
      "github.event_name=='pull_request'&&needs.trust-check.outputs.trusted=='true'";
    if (!directGate.test(condition) && condition !== changesetGate && delegated !== trustedInput)
      failures.push(name);
  }
  return failures;
};

test("every CI job that can execute repository code depends on the fork trust gate", () => {
  assert.ok(jobs(workflow).length > 2);
  assert.deepEqual(violations(workflow), []);
});

test("the guard catches missing trust dependencies in every guarded job", () => {
  for (const [, name, body] of jobs(workflow)) {
    if (name === "trust-check" || name === "check-changes" || name === "workflow-lint") continue;
    const unguarded = body.replace(/^    needs:[^\n]*\n/m, "");
    assert.notEqual(unguarded, body);
    assert.ok(violations(workflow.replace(body, unguarded)).includes(name), name);
  }
});

test("new code jobs and executable metadata steps cannot bypass the guard", () => {
  assert.deepEqual(
    violations(
      workflow +
        "\n  new-release-check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node scripts/version-sync.mjs check\n",
    ),
    ["new-release-check"],
  );
  const metadata = workflow.replace(
    "  check-changes:\n",
    "  check-changes:\n    run: node scripts/version-sync.mjs check\n",
  );
  assert.ok(violations(metadata).includes("check-changes"));
});

const aiWorkflow = readFileSync(
  new URL("../.github/workflows/ai-sync.yml", import.meta.url),
  "utf8",
);
test("the AI sync workflow also gates repository scripts", () => {
  assert.deepEqual(violations(aiWorkflow), []);
  const unguarded = aiWorkflow.replace("    needs: [trust-check]\n", "");
  assert.notEqual(unguarded, aiWorkflow);
  assert.ok(violations(unguarded).includes("sync-ai"));
});
