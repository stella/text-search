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

function readVersion() {
  return fs.readFileSync(repoPath("VERSION"), "utf8").trim();
}

function writeVersion(version) {
  fs.writeFileSync(repoPath("VERSION"), `${version}\n`);
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

  writeVersion(nextVersion);
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

  const version = readVersion();
  if (version !== expectedVersion) {
    mismatches.push(`${repoPath("VERSION")}: version=${version}`);
  }
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

  if (command !== "sync" && command !== "check") {
    console.error(
      "Usage: node scripts/version-sync.mjs <sync|check> [--version <semver>] [--tag <git-tag>]",
    );
    process.exit(1);
  }

  const version = args.get("version") ?? args.get("tag")?.replace(/^v/, "") ?? readVersion();

  if (command === "sync") {
    syncVersion(version);
    return;
  }

  if (command === "check") {
    const mismatches = describeMismatches(version);
    if (mismatches.length > 0) {
      console.error("Version drift detected:");
      for (const mismatch of mismatches) {
        console.error(`- ${mismatch}`);
      }
      process.exit(1);
    }
    return;
  }
}

main();
