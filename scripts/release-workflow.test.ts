import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

const readJob = (name: string) => {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);

  expect(start).not.toBe(-1);

  const bodyStart = start + marker.length;
  const remainder = workflow.slice(bodyStart);
  const nextJob = remainder.search(/^  [A-Za-z_][A-Za-z0-9_-]*:\n/m);

  return nextJob === -1 ? workflow.slice(start) : workflow.slice(start, bodyStart + nextJob);
};

test("builds packages without npm publishing credentials", () => {
  const verify = readJob("verify");
  const pack = readJob("pack");

  expect(verify).toContain("persist-credentials: false");
  expect(pack).toContain("persist-credentials: false");
  expect(pack).toContain(
    'npm install --global --ignore-scripts "@cyclonedx/cdxgen@${CDXGEN_VERSION}"',
  );
  expect(pack).toContain("permissions:\n      contents: read");
  expect(pack).not.toContain("contents: write");
  expect(pack).not.toContain("id-token: write");
});

test("delegates synchronized publishing with the guarded release contract", () => {
  const finalize = readJob("finalize");

  expect(finalize).toContain(
    "github.ref == 'refs/heads/main'\n      && (needs.preflight.outputs.already-released != 'true'",
  );
  expect(finalize).toContain(
    "uses: stella/.github/.github/workflows/npm-version-finalize.yml@eabb8b7de6cc69e1bbd3468ee80ddaf99cbddc33",
  );
  expect(finalize).toContain("permissions:\n      contents: write\n      id-token: write");
  expect(finalize).not.toContain("pull-requests: write");
  expect(finalize).not.toContain("secrets: inherit");
  expect(finalize).toContain("CHANGELOG_APP_ID: ${{ secrets.CHANGELOG_APP_ID }}");
  expect(finalize).toContain("CHANGELOG_APP_PRIVATE_KEY: ${{ secrets.CHANGELOG_APP_PRIVATE_KEY }}");
});
