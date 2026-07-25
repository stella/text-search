import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PACKAGE_FILE = "package.json";
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-(?:alpha|beta|rc)\.[0-9]+)?$/;

const { version } = JSON.parse(readFileSync(PACKAGE_FILE, "utf8"));
if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
  console.error(`${PACKAGE_FILE} has invalid version '${version}'`);
  process.exit(1);
}

execFileSync("cargo", ["metadata", "--locked", "--no-deps", "--format-version", "1"], {
  stdio: "ignore",
});
execFileSync(process.execPath, ["scripts/version-sync.mjs", "sync", "--version", version], {
  stdio: "inherit",
});
