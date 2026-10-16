import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("runs parity on shared detector changes and preserves domain checks", () => {
  const workflow = read(".github/workflows/ci.yml");
  expect(workflow).toContain('stll-toolchain-changed --since "$BASE_REF"');
  expect(workflow).toContain("fetch-depth: 0");
  expect(workflow).toContain("bun install --frozen-lockfile --ignore-scripts");
  expect(workflow).toContain("github.event.pull_request.base.sha || github.event.before");
  expect(workflow).toContain("'unavailable-toolchain-base'");
  expect(workflow).toContain("steps.filter.outputs.code == 'true' || steps.toolchain.outputs.changed == 'true'");
  expect(workflow).toContain("if: needs.check-changes.outputs.toolchain-changed == 'true'");
  const domain = workflow.split("            code:").at(1)?.split("            provenance:").at(0);
  expect(domain).toContain("'crates/**'");
  expect(domain).toContain("'src/**'");
  expect(domain).not.toContain("'bun.lock'");
  expect(domain).not.toContain("'package.json'");
});
