#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function repoPath(...segments) {
  return path.join(ROOT, ...segments);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs() {
  const [command, ...rest] = process.argv.slice(2);
  const args = new Map();

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--version" || token === "--tag") {
      const value = rest[i + 1];
      if (value == null) {
        throw new Error(`Missing value for ${token}`);
      }
      args.set(token.slice(2), value);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return { command, args };
}

function syncVersion(nextVersion) {
  const rootPath = repoPath("package.json");
  const wasmPath = repoPath("wasm", "package.json");

  const root = readJson(rootPath);
  const wasm = readJson(wasmPath);

  root.version = nextVersion;
  wasm.version = nextVersion;

  writeJson(rootPath, root);
  writeJson(wasmPath, wasm);
}

function describeMismatches(expectedVersion) {
  const mismatches = [];
  const rootPath = repoPath("package.json");
  const wasmPath = repoPath("wasm", "package.json");

  const root = readJson(rootPath);
  const wasm = readJson(wasmPath);

  if (root.version !== expectedVersion) {
    mismatches.push(`${rootPath}: version=${root.version}`);
  }
  if (wasm.version !== expectedVersion) {
    mismatches.push(`${wasmPath}: version=${wasm.version}`);
  }

  return mismatches;
}

function main() {
  const { command, args } = parseArgs();
  const rootVersion = readJson(repoPath("package.json")).version;

  if (command === "sync") {
    syncVersion(args.get("version") ?? rootVersion);
    return;
  }

  if (command === "check") {
    const expectedVersion = args.get("tag")
      ? args.get("tag").replace(/^v/, "")
      : rootVersion;
    const mismatches = describeMismatches(expectedVersion);
    if (mismatches.length > 0) {
      console.error("Version drift detected:");
      for (const mismatch of mismatches) {
        console.error(`- ${mismatch}`);
      }
      process.exit(1);
    }
    return;
  }

  console.error(
    "Usage: node scripts/version-sync.mjs <sync|check> [--version <semver>] [--tag <git-tag>]",
  );
  process.exit(1);
}

main();
